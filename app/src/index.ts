import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { bodyLimit } from 'hono/body-limit'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { hostname } from 'os'
import { createBullBoard } from '@bull-board/api'
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter'
import { HonoAdapter } from '@bull-board/hono'
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { prisma } from './lib/prisma.js'
import { jobQueue } from './lib/queue.js'
import { log } from './lib/log.js'
import type { GenerateThumbnailJobData } from './workers/thumbnail.js'
import type { CreateArchiveJobData } from './workers/archive.js'
import { renderHomePage } from './views/Home.js'

const app = new Hono()

// リクエストログ出力
app.use(logger())

// API へのリクエストボディは上限を設ける（無制限のメモリ確保を防ぐ）
app.use('/api/*', bodyLimit({ maxSize: 100 * 1024 }))

// トップページの CSS / クライアント JS を静的配信する
app.use('/*', serveStatic({ root: './public' }))

// 未処理の例外を1箇所でまとめて拾う。個別のルートにtry/catchを撒かない
app.onError((err, c) => {
  log.error(`Unhandled error: ${c.req.method} ${c.req.path}`, err)
  return c.json({ error: 'Internal Server Error' }, 500)
})

const HOSTNAME = hostname()
const AWS_ENDPOINT = process.env.AWS_ENDPOINT || 'http://localhost:4566'
const AWS_PUBLIC_ENDPOINT = process.env.AWS_PUBLIC_ENDPOINT || 'http://localhost:4566'
const S3_BUCKET = 'uploads'

// デバッグ用エンドポイント（競合状態の体験用）のスイッチ。デモなので既定で有効。
// 実運用でこの種の操作系エンドポイントを置く場合は、無効化に加えて必ず認証を掛けること
const ENABLE_DEBUG_ENDPOINTS = process.env.ENABLE_DEBUG_ENDPOINTS !== 'false'

// アップロードを許可する画像形式と、S3 キーに使う拡張子
const UPLOAD_CONTENT_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

// サーバが発行するアップロードキーの形式（UUID + 許可済み拡張子）。
// thumbnails/ や archives/ など別用途のキーはこの形式に一致しない
const UPLOAD_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/

// fileIds はクライアント申告の配列なので、型・件数を検証し重複を除いてから使う
function parseFileIds(input: unknown): string[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > 100) {
    return null
  }
  if (!input.every((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 64)) {
    return null
  }
  return [...new Set(input)]
}

// S3 Client (内部通信用)
const s3Client = new S3Client({
  endpoint: AWS_ENDPOINT,
  region: process.env.AWS_REGION || 'ap-northeast-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
  forcePathStyle: true,
})

// S3 Client (署名付きURL生成用 - ブラウザからアクセスできるエンドポイント)
const s3ClientPublic = new S3Client({
  endpoint: AWS_PUBLIC_ENDPOINT,
  region: process.env.AWS_REGION || 'ap-northeast-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
})

// 回収ジョブを毎分実行するよう登録する。
// upsert なのでサーバーが何台起動しても登録は1つに収束し、発火は
// キュー（Redis）が一元管理するため、ワーカーが何台いても各回1回だけ実行される。
// 毎分成功し続けるジョブで管理画面が埋まらないよう、成功分は少数だけ残して自動削除する
await jobQueue.upsertJobScheduler(
  'sweep-stuck-archives',
  { pattern: '* * * * *' },
  {
    name: 'sweep-stuck-archives',
    opts: {
      // 回収ジョブは毎分やり直されるので、ジョブ既定のリトライは付けない
      attempts: 1,
      removeOnComplete: { count: 5 },
      removeOnFail: { count: 20 },
    },
  }
)

// Bull Board setup
const serverAdapter = new HonoAdapter(serveStatic)
serverAdapter.setBasePath('/admin/queues')
createBullBoard({
  queues: [new BullMQAdapter(jobQueue)],
  serverAdapter,
})

// Mount Bull Board
app.route('/admin/queues', serverAdapter.registerPlugin())

// トップページ
app.get('/', (c) => {
  return c.html(renderHomePage(HOSTNAME))
})

// ヘルスチェック
app.get('/health', (c) => {
  return c.json({ status: 'ok', hostname: HOSTNAME })
})

// 署名付きURL生成API
app.post('/api/upload-url', async (c) => {
  const { contentType } = await c.req.json().catch(() => ({}))

  const ext =
    typeof contentType === 'string' && Object.hasOwn(UPLOAD_CONTENT_TYPES, contentType)
      ? UPLOAD_CONTENT_TYPES[contentType]
      : undefined
  if (!ext) {
    return c.json({ error: 'アップロードできるのは画像ファイルのみです' }, 400)
  }

  // ユーザー入力（ファイル名）は S3 キーに混ぜない。キーは完全にサーバ側で生成し、
  // 元のファイル名は DB の originalName としてだけ保持する。
  // 時刻はユニーク性の保証にならない（同一ミリ秒で衝突しうる）ので UUID を使う
  const key = `${crypto.randomUUID()}${ext}`

  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ContentType: contentType,
  })

  // ブラウザからアクセスできるエンドポイントで署名を生成
  const uploadUrl = await getSignedUrl(s3ClientPublic, command, { expiresIn: 300 })

  return c.json({ uploadUrl, key, hostname: HOSTNAME })
})

// ファイル一覧取得API（DBから）
app.get('/api/files', async (c) => {
  const files = await prisma.uploadedFile.findMany({
    include: { thumbnail: true },
    orderBy: { createdAt: 'desc' },
  })

  return c.json({
    files: files.map(f => ({
      id: f.id,
      s3Key: f.s3Key,
      originalName: f.originalName,
      contentType: f.contentType,
      size: f.size,
      createdAt: f.createdAt,
      hasThumbnail: !!f.thumbnail,
      thumbnailS3Key: f.thumbnail?.s3Key,
    })),
    hostname: HOSTNAME
  })
})

// ファイル登録API（DB登録 + サムネイル生成ジョブ投入）
app.post('/api/files', async (c) => {
  const { s3Key, originalName } = await c.req.json().catch(() => ({}))

  // s3Key はクライアント申告値なので信用しない。サーバが発行した形式に一致し、
  // 実際にアップロード済みのオブジェクトだけを受理する（別用途のキーや
  // 存在しないキーを DB に紐付けられるのを防ぐ）
  if (typeof s3Key !== 'string' || !UPLOAD_KEY_PATTERN.test(s3Key)) {
    return c.json({ error: '不正なキーです' }, 400)
  }
  if (
    typeof originalName !== 'string' ||
    originalName.length === 0 ||
    originalName.length > 255 ||
    // \p{Cc}: Unicode の制御文字カテゴリ（改行・タブなどを含む）
    /\p{Cc}/u.test(originalName)
  ) {
    return c.json({ error: 'ファイル名が不正です' }, 400)
  }

  // サイズと Content-Type はクライアント申告ではなく S3 上の実物から取得する
  let size: number
  let contentType: string
  try {
    const head = await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: s3Key }))
    size = head.ContentLength ?? 0
    contentType = head.ContentType ?? 'application/octet-stream'
  } catch {
    return c.json({ error: 'アップロードが完了していません' }, 404)
  }

  // DBに登録
  const file = await prisma.uploadedFile.create({
    data: { s3Key, originalName, contentType, size },
  })

  // サムネイル生成ジョブを投入
  const job = await jobQueue.add('generate-thumbnail', {
    fileId: file.id,
  } satisfies GenerateThumbnailJobData)

  return c.json({
    file: {
      id: file.id,
      s3Key: file.s3Key,
      originalName: file.originalName,
    },
    thumbnailJobId: job.id,
    hostname: HOSTNAME,
  })
})

// サムネイル生成ジョブ投入API（デバッグ用）
app.post('/api/files/:fileId/thumbnail', async (c) => {
  if (!ENABLE_DEBUG_ENDPOINTS) {
    return c.json({ error: 'debug endpoints are disabled' }, 404)
  }
  const fileId = c.req.param('fileId')

  const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } })
  if (!file) {
    return c.json({ error: 'ファイルが見つかりません' }, 404)
  }

  const job = await jobQueue.add('generate-thumbnail', {
    fileId: file.id,
  } satisfies GenerateThumbnailJobData)

  return c.json({ jobId: job.id, fileId, hostname: HOSTNAME })
})

// サムネイル情報取得API
app.get('/api/files/:fileId/thumbnail', async (c) => {
  const fileId = c.req.param('fileId')

  const thumbnail = await prisma.thumbnail.findUnique({
    where: { fileId },
    include: { file: true },
  })

  if (!thumbnail) {
    return c.json({ error: 'サムネイルが見つかりません' }, 404)
  }

  // 署名付きURLを生成してサムネイル画像を取得できるようにする
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: thumbnail.s3Key,
  })
  const url = await getSignedUrl(s3ClientPublic, command, { expiresIn: 300 })

  return c.json({
    thumbnail: {
      id: thumbnail.id,
      s3Key: thumbnail.s3Key,
      width: thumbnail.width,
      height: thumbnail.height,
      url,
    },
    hostname: HOSTNAME,
  })
})

// アーカイブ一覧取得API
app.get('/api/archives', async (c) => {
  const archives = await prisma.archive.findMany({
    include: { files: { include: { file: true } } },
    orderBy: { createdAt: 'desc' },
  })

  return c.json({
    archives: archives.map(a => ({
      id: a.id,
      s3Key: a.s3Key,
      status: a.status,
      size: a.size,
      fileCount: a.fileCount,
      createdAt: a.createdAt,
      startedAt: a.startedAt,
      completedAt: a.completedAt,
      failedAt: a.failedAt,
      // 内部エラーの詳細（接続先やドライバのメッセージ等）は外に出さない。詳細は DB とログに残る
      errorMessage: a.errorMessage ? 'アーカイブの作成に失敗しました' : null,
    })),
    hostname: HOSTNAME,
  })
})

// アーカイブ詳細取得API
app.get('/api/archives/:id', async (c) => {
  const id = c.req.param('id')

  const archive = await prisma.archive.findUnique({
    where: { id },
    include: { files: { include: { file: true } } },
  })

  if (!archive) {
    return c.json({ error: 'アーカイブが見つかりません' }, 404)
  }

  // 完了済みなら署名付きURLを生成
  let downloadUrl: string | null = null
  if (archive.status === 'COMPLETED') {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: archive.s3Key,
    })
    downloadUrl = await getSignedUrl(s3ClientPublic, command, { expiresIn: 300 })
  }

  return c.json({
    archive: {
      id: archive.id,
      s3Key: archive.s3Key,
      status: archive.status,
      size: archive.size,
      fileCount: archive.fileCount,
      createdAt: archive.createdAt,
      startedAt: archive.startedAt,
      completedAt: archive.completedAt,
      failedAt: archive.failedAt,
      // 内部エラーの詳細は外に出さない（一覧APIと同じ方針）
      errorMessage: archive.errorMessage ? 'アーカイブの作成に失敗しました' : null,
      downloadUrl,
      files: archive.files.map(af => ({
        id: af.file.id,
        originalName: af.file.originalName,
        s3Key: af.file.s3Key,
      })),
    },
    hostname: HOSTNAME,
  })
})

// アーカイブ作成ジョブ投入API
app.post('/api/archives', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const fileIds = parseFileIds(body.fileIds)
  if (!fileIds) {
    return c.json({ error: 'ファイルを選択してください（最大100件）' }, 400)
  }

  // ファイルの存在確認
  const files = await prisma.uploadedFile.findMany({
    where: { id: { in: fileIds } },
  })
  if (files.length !== fileIds.length) {
    return c.json({ error: '一部のファイルが見つかりません' }, 400)
  }

  // Archiveレコードを作成（status: PENDING）
  const s3Key = `archives/archive-${crypto.randomUUID()}.zip`
  const archive = await prisma.archive.create({
    data: {
      s3Key,
      fileCount: fileIds.length,
      files: {
        create: fileIds.map((fileId: string) => ({ fileId })),
      },
    },
  })

  // ジョブを投入
  const job = await jobQueue.add('create-archive', {
    archiveId: archive.id,
  } satisfies CreateArchiveJobData)

  return c.json({
    archive: {
      id: archive.id,
      s3Key: archive.s3Key,
      status: archive.status,
      fileCount: archive.fileCount,
    },
    jobId: job.id,
    hostname: HOSTNAME,
  })
})

// デバッグ用: 同じアーカイブに2件のジョブを同時投入
app.post('/api/archives/debug-duplicate', async (c) => {
  if (!ENABLE_DEBUG_ENDPOINTS) {
    return c.json({ error: 'debug endpoints are disabled' }, 404)
  }
  const body = await c.req.json().catch(() => ({}))
  const fileIds = parseFileIds(body.fileIds)
  if (!fileIds) {
    return c.json({ error: 'ファイルを選択してください（最大100件）' }, 400)
  }

  // ファイルの存在確認
  const files = await prisma.uploadedFile.findMany({
    where: { id: { in: fileIds } },
  })
  if (files.length !== fileIds.length) {
    return c.json({ error: '一部のファイルが見つかりません' }, 400)
  }

  // Archiveレコードを1つ作成
  const s3Key = `archives/archive-${crypto.randomUUID()}.zip`
  const archive = await prisma.archive.create({
    data: {
      s3Key,
      fileCount: fileIds.length,
      files: {
        create: fileIds.map((fileId: string) => ({ fileId })),
      },
    },
  })

  // 同じarchiveIdを持つジョブを2件同時に投入
  const [job1, job2] = await Promise.all([
    jobQueue.add('create-archive', { archiveId: archive.id } satisfies CreateArchiveJobData),
    jobQueue.add('create-archive', { archiveId: archive.id } satisfies CreateArchiveJobData),
  ])

  return c.json({
    archive: {
      id: archive.id,
      s3Key: archive.s3Key,
      status: archive.status,
      fileCount: archive.fileCount,
    },
    jobIds: [job1.id, job2.id],
    hostname: HOSTNAME,
  })
})

const port = 3000
log.info(`Server running on port ${port} (hostname: ${HOSTNAME})`)

const server = serve({
  fetch: app.fetch,
  port,
})

/**
 * 停止シグナルを受けたら、処理中のリクエストを終えてから終了する。
 * @see https://hono.dev/docs/getting-started/nodejs （graceful shutdownの公式例）
 */
const shutdown = (signal: string) => {
  log.info(`${signal} received, waiting for active requests to finish...`)
  server.close((err) => {
    if (err) {
      log.error('Failed to close server', err)
    }
    process.exit(err ? 1 : 0)
  })
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
