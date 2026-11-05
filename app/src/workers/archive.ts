import type { Job } from 'bullmq'
import type { PrismaClient, Archive } from '@prisma/client'
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import archiver from 'archiver'
import { PassThrough, Readable } from 'stream'
import { prisma } from '../lib/prisma.js'
import { isRetryableError } from '../lib/errors.js'
import { HOSTNAME } from '../lib/host.js'
import { log } from '../lib/log.js'
import { S3_BUCKET, s3Client } from '../lib/s3.js'

// claimArchive の結果。処理権を取れたとき（claimed）だけ archive を持つ
export type ClaimResult =
  | { status: 'claimed'; archive: Archive }
  | { status: 'skipped' }
  | { status: 'not_found' }

// 冪等性の核（パターン2: 状態フラグ + 行ロック）
// SELECT FOR UPDATE NOWAIT で行ロック → PENDING のみ PROCESSING に遷移
// ロック取得失敗（"could not obtain lock"）はそのまま throw して呼び出し側のリトライ戦略に委ねる
export async function claimArchive(
  client: PrismaClient,
  archiveId: string
): Promise<ClaimResult> {
  return client.$transaction(async (tx) => {
    const records = await tx.$queryRaw<Archive[]>`
      SELECT * FROM "Archive" WHERE id = ${archiveId} FOR UPDATE NOWAIT
    `
    if (records.length === 0) {
      return { status: 'not_found' }
    }

    const record = records[0]
    if (record.status !== 'PENDING') {
      return { status: 'skipped' }
    }

    const updated = await tx.archive.update({
      where: { id: archiveId },
      data: { status: 'PROCESSING', startedAt: new Date() }
    })
    return { status: 'claimed', archive: updated }
  })
}

// アーカイブ対象（S3 上の取得元キーと、元のファイル名）
type ArchiveSource = { s3Key: string; originalName: string }

// ZIP を生成しながら S3 へアップロードし、アップロード後のサイズ（バイト）を返す。
// S3 の操作はこの関数に閉じている（呼び出し側はロックと状態遷移に集中する）
async function createAndUploadZip(zipKey: string, sources: ArchiveSource[]): Promise<number> {
  // ZIP 内のエントリ名は利用者由来の originalName を使うため、パス区切りを取り除く
  // （../ 入りのエントリ名は、展開側の実装によってはディレクトリ外に書き込まれる）。
  // 同名ファイルは連番を付けて衝突を避ける
  const usedNames = new Set<string>()
  const files = sources.map(src => {
    const base = src.originalName.split('/').pop()?.split('\\').pop() || 'file'
    let name = base
    for (let n = 2; usedNames.has(name); n++) {
      name = `${n}-${base}`
    }
    usedNames.add(name)
    return { s3Key: src.s3Key, name }
  })

  log.info(`Creating archive: ${zipKey}`)
  log.info(`Files to archive: ${files.map(f => f.s3Key).join(', ')}`)

  // ZIP を生成しながらそのまま S3 へアップロードする。archiver のストリームは
  // Node コア製ではなく Upload がそのまま受け取れないため、PassThrough を挟む
  const archiveStream = archiver('zip', { zlib: { level: 9 } })
  const zipStream = new PassThrough()
  archiveStream.pipe(zipStream)
  // pipe はエラーを伝えないので、ZIP 生成側の失敗を明示的にアップロード側へ伝える
  archiveStream.on('error', (error) => zipStream.destroy(error))
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: S3_BUCKET,
      Key: zipKey,
      Body: zipStream,
      ContentType: 'application/zip',
    },
  })
  // done() は名前に反して「開始」も兼ねる: 呼んだ時点で zipStream の送信が始まり、
  // 以後 ZIP の生成と並行してアップロードが進む（返り値は完了を待つための Promise）
  const uploadPromise = upload.done()

  for (const file of files) {
    log.info(`Adding file: ${file.s3Key}`)

    const getCommand = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: file.s3Key,
    })
    const response = await s3Client.send(getCommand)
    // Body の型はブラウザ兼用の合併型だが、Node.js では常に Readable が返る
    if (!(response.Body instanceof Readable)) {
      throw new Error(`S3 object has no readable body: ${file.s3Key}`)
    }
    // 取得ストリームをバッファに展開せず、そのまま ZIP エントリとして流し込む。
    // archiver がこのエントリを消費し終わるのを待ってから次のファイルを取得する
    // （未消費の S3 接続を同時に溜め込まないため）
    const consumed = new Promise(resolve => archiveStream.once('entry', resolve))
    archiveStream.append(response.Body, { name: file.name })
    await consumed
  }

  await archiveStream.finalize()
  await uploadPromise

  // ストリーミングしたのでサイズは手元にない。S3 に問い合わせる
  const head = await s3Client.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: zipKey }))
  const zipSize = head.ContentLength ?? 0
  log.info(`Archive uploaded: ${zipKey} (${zipSize} bytes)`)
  return zipSize
}

// ジョブ投入側（index.ts）と共有するペイロードの型
export type CreateArchiveJobData = { archiveId: string }

// パターン2: ZIPアーカイブ作成ジョブ（状態フラグ+ロックで冪等性担保）
export async function processCreateArchive(job: Job<CreateArchiveJobData>) {
  const { archiveId } = job.data

  log.info(`Processing create-archive job ${job.id} for archive: ${archiveId}`)

  // 1. 処理権の取得（claim）
  //   - SELECT FOR UPDATE NOWAIT: 状態を遷移させる瞬間を行ロックで保護
  //   - 状態フラグ PROCESSING: ロック解放後（重い処理の間）に他ワーカーが入ってきても、
  //     PENDING 以外なら skipped に分岐させ、重い処理が二重に走るのを防ぐ
  let claimResult: ClaimResult
  try {
    claimResult = await claimArchive(prisma, archiveId)
  } catch (error) {
    if (isRetryableError(error)) {
      log.warn(`[${job.id}] Retryable error, will retry: ${error}`)
      throw error
    }
    log.error(`[${job.id}] Non-retryable error, skipping: ${error}`)
    return { status: 'error', error: String(error) }
  }

  if (claimResult.status === 'not_found') {
    log.error(`[${job.id}] Archive not found, skipping: ${archiveId}`)
    return { status: 'not_found' }
  }
  if (claimResult.status === 'skipped') {
    log.info(`[${job.id}] Archive ${archiveId} already processed or processing, skipping`)
    return { status: 'skipped' }
  }
  // ここに来るのは claimed のときだけなので、archive は必ず存在する
  const archive = claimResult.archive

  // 2. 実際のZIP作成処理（S3 の操作は createAndUploadZip に集約）
  try {
    const archiveFiles = await prisma.archiveFile.findMany({
      where: { archiveId },
      include: { file: true }
    })
    const archiveSize = await createAndUploadZip(
      archive.s3Key,
      archiveFiles.map(af => ({ s3Key: af.file.s3Key, originalName: af.file.originalName }))
    )

    await prisma.archive.update({
      where: { id: archiveId },
      data: { status: 'COMPLETED', completedAt: new Date(), size: archiveSize }
    })

    return {
      status: 'completed',
      s3Key: archive.s3Key,
      fileCount: archiveFiles.length,
      size: archiveSize,
      processedBy: HOSTNAME,
    }
  } catch (error) {
    if (isRetryableError(error)) {
      // リトライ可能 → PENDING に戻して再スロー（状態ガード付き）
      try {
        await prisma.archive.updateMany({
          where: { id: archiveId, status: 'PROCESSING' },
          data: { status: 'PENDING' }
        })
      } catch (resetError) {
        // 戻す更新自体も失敗しうる（典型は DB 断 — 元のエラーと同じ理由で）。
        // 元のエラーを失わず記録だけ残す。戻せなかった PROCESSING は回収ジョブが回復する
        log.error(`[${job.id}] Failed to reset archive to PENDING:`, resetError)
      }
      log.warn(`[${job.id}] Retryable error, reset to PENDING: ${error}`)
      throw error
    }

    // リトライ不可（試しても無駄と判断）→ FAILED として決着し、握り潰す
    try {
      await prisma.archive.update({
        where: { id: archiveId },
        data: { status: 'FAILED', failedAt: new Date(), errorMessage: String(error) }
      })
    } catch (updateError) {
      // FAILED を書けなかった（典型は DB 断 — 元のエラーと同じ理由で）。
      // 元のエラーを失わず記録だけ残す。残った PROCESSING は回収ジョブが回復する
      log.error(`[${job.id}] Failed to mark archive as FAILED:`, updateError)
    }
    log.error(`[${job.id}] Non-retryable error during archive creation: ${error}`)
    return { status: 'failed', error: String(error) }
  }
}
