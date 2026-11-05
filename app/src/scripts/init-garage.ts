// Garage（S3互換ストレージ）の初期化。docker compose up 時に one-shot サービスとして
// 実行され、クラスタ layout・バケット・アクセスキー・CORS をまとめて設定する。
// 何度実行しても安全（layout・バケット・アクセスキーは設定済みならスキップし、
// 権限付与と CORS は毎回同じ内容で上書きするだけなので実害がない）。
//
// Garage の CLI バイナリ（/garage）は使わない。イメージがシェルすら持たない
// 最小構成で、他のコンテナに持ち込むには追加のビルド手順が要るため、代わりに
// Garage の管理API（HTTP）を直接叩く。CORS 設定だけは管理APIに無いので、
// このアプリが既に使っている S3 SDK（署名付きAPI）で設定する。
import { PutBucketCorsCommand } from '@aws-sdk/client-s3'
import { s3Client, S3_BUCKET } from '../lib/s3.js'
import { log } from '../lib/log.js'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`環境変数 ${name} が未設定です`)
  }
  return value
}

const ADMIN_ENDPOINT = process.env.GARAGE_ADMIN_ENDPOINT || 'http://garage:3903'
const ADMIN_TOKEN = requireEnv('GARAGE_ADMIN_TOKEN')
const ACCESS_KEY_ID = requireEnv('AWS_ACCESS_KEY_ID')
const SECRET_ACCESS_KEY = requireEnv('AWS_SECRET_ACCESS_KEY')

async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${ADMIN_ENDPOINT}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${ADMIN_TOKEN}` },
  })
}

// 0. Garage プロセスが起動していても、管理APIがすぐに応答するとは限らない
// （compose の depends_on はコンテナの起動開始しか保証しない）ため、
// 応答するまで待つ。1秒間隔で最大30回 = 30秒。Garage自体の起動は通常1秒
// 未満だが、読者のマシンの性能や負荷はさまざまなので余裕を持たせている。
// 30秒待っても応答しなければ、一時的な遅延ではなく起動自体の失敗とみなす
async function waitForGarage(): Promise<void> {
  const maxAttempts = 30
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await adminFetch('/v1/status')
      if (res.ok) {
        return
      }
    } catch {
      // Garage がまだ起動していない。待って再試行する
    }
    if (attempt === maxAttempts) {
      throw new Error('Garage の起動待ちがタイムアウトしました')
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

// 1. クラスタ layout。ノードにゾーン・容量を割り当てないと、バケット作成以降の
// すべての操作が失敗する
async function setupLayout(): Promise<void> {
  const layoutRes = await adminFetch('/v1/layout')
  if (!layoutRes.ok) {
    throw new Error(`layout の取得に失敗しました: ${layoutRes.status}`)
  }
  const layout = (await layoutRes.json()) as { version: number; roles: unknown[] }
  if (layout.roles.length > 0) {
    log.info('Garage layout は設定済みです')
    return
  }

  const statusRes = await adminFetch('/v1/status')
  if (!statusRes.ok) {
    throw new Error(`ノード情報の取得に失敗しました: ${statusRes.status}`)
  }
  const status = (await statusRes.json()) as { nodes: { id: string }[] }
  const node = status.nodes[0]
  if (!node) {
    throw new Error('クラスタにノードが見つかりません')
  }

  log.info('Garage layout を設定します')
  await adminFetch('/v1/layout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ id: node.id, zone: 'dc1', capacity: 1_000_000_000, tags: [] }]),
  })
  await adminFetch('/v1/layout/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: layout.version + 1 }),
  })
}

// 2. バケット作成。GET が 404 を返すのは「バケットが存在しない」ときだけ
// （実測で確認済み）なので、それ以外のエラーステータスは異常として扱う
async function ensureBucket(): Promise<string> {
  const res = await adminFetch(`/v1/bucket?globalAlias=${S3_BUCKET}`)
  if (res.status === 404) {
    log.info(`バケット ${S3_BUCKET} を作成します`)
    const createRes = await adminFetch('/v1/bucket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalAlias: S3_BUCKET }),
    })
    if (!createRes.ok) {
      throw new Error(`バケット作成に失敗しました: ${createRes.status}`)
    }
    const created = (await createRes.json()) as { id: string }
    return created.id
  }
  if (!res.ok) {
    throw new Error(`バケット情報の取得に失敗しました: ${res.status}`)
  }
  const bucket = (await res.json()) as { id: string }
  log.info(`バケット ${S3_BUCKET} は作成済みです`)
  return bucket.id
}

// 3. アクセスキーの import（docker-compose.yml の環境変数と同じ資格情報を登録する。
// キーをここで新規発行せず import するのは、認証情報を1箇所（環境変数）に
// 一元化するため）。GET が 400 を返すのは「キーが存在しない」ときだけ（実測で確認済み）
async function ensureAccessKey(): Promise<void> {
  const res = await adminFetch(`/v1/key?id=${ACCESS_KEY_ID}`)
  if (res.status === 400) {
    log.info('アクセスキーを登録します')
    const importRes = await adminFetch('/v1/key/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY, name: 'app-key' }),
    })
    if (!importRes.ok) {
      throw new Error(`アクセスキーの登録に失敗しました: ${importRes.status}`)
    }
    return
  }
  if (!res.ok) {
    throw new Error(`アクセスキー情報の取得に失敗しました: ${res.status}`)
  }
  log.info('アクセスキーは登録済みです')
}

// 4. バケットへの権限付与。毎回同じ内容で上書きするだけなので冪等
async function allowBucketAccess(bucketId: string): Promise<void> {
  const res = await adminFetch('/v1/bucket/allow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bucketId,
      accessKeyId: ACCESS_KEY_ID,
      permissions: { read: true, write: true, owner: true },
    }),
  })
  if (!res.ok) {
    throw new Error(`権限付与に失敗しました: ${res.status}`)
  }
}

// 5. CORS 設定。ブラウザから署名付きURLへ直接 PUT するために必須（第5章）。
// 毎回同じ内容で上書きするだけなので冪等
async function setupCors(): Promise<void> {
  await s3Client.send(
    new PutBucketCorsCommand({
      Bucket: S3_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ['*'],
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag'],
          },
        ],
      },
    })
  )
}

async function main(): Promise<void> {
  await waitForGarage()
  await setupLayout()
  const bucketId = await ensureBucket()
  await ensureAccessKey()
  await allowBucketAccess(bucketId)
  await setupCors()
  log.info('Garage の初期化が完了しました')
}

main().catch((error: unknown) => {
  log.error('Garage の初期化に失敗しました', error)
  process.exit(1)
})
