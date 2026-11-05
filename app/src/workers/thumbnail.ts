import type { Job } from 'bullmq'
import type { PrismaClient } from '@prisma/client'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import sharp from 'sharp'
import { prisma, Prisma } from '../lib/prisma.js'
import { isRetryableError } from '../lib/errors.js'
import { log } from '../lib/log.js'
import { S3_BUCKET, s3Client } from '../lib/s3.js'

// サムネイルの寸法情報（DB に保存するメタデータ）
export type ThumbnailMeta = { width: number; height: number }

// 冪等性の核（パターン1: Unique制約）
// INSERT + P2002 catch（最終ガード）。同時実行で同じ fileId が同時に来ても、
// Unique制約違反を already_exists として扱うことで二重登録を防ぐ
export async function createThumbnailIfAbsent(
  client: PrismaClient,
  fileId: string,
  s3Key: string,
  meta: ThumbnailMeta
): Promise<{ status: 'created' | 'already_exists' }> {
  try {
    await client.thumbnail.create({ data: { fileId, s3Key, ...meta } })
    return { status: 'created' }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return { status: 'already_exists' }
    }
    throw error
  }
}

// 元画像をS3から取得してサムネイルを生成し、S3へアップロードして寸法情報を返す。
// S3の操作はこの関数に閉じている（呼び出し側は冪等性の制御に集中する）
async function generateAndUploadThumbnail(sourceKey: string, thumbnailKey: string): Promise<ThumbnailMeta> {
  const getCommand = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: sourceKey,
  })
  const response = await s3Client.send(getCommand)
  // Body の型はブラウザ兼用の合併型だが、Node.js では常に Readable が返る
  if (!(response.Body instanceof Readable)) {
    throw new Error(`S3 object has no readable body: ${sourceKey}`)
  }

  // サムネイル生成（幅200pxにリサイズ）。元画像をメモリに全展開せず、
  // S3 の取得ストリームを sharp に直接流し込む。pipeline を使うことで
  // 取得側のエラーも reject として伝播する（縮小後のサムネイルは小さいので Buffer で受ける）
  const resizer = sharp()
    .resize(200, null, { withoutEnlargement: true })
    .jpeg({ quality: 80 })
  const [thumbnailBuffer] = await Promise.all([
    resizer.toBuffer(),
    pipeline(response.Body, resizer),
  ])

  const metadata = await sharp(thumbnailBuffer).metadata()

  const putCommand = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: thumbnailKey,
    Body: thumbnailBuffer,
    ContentType: 'image/jpeg',
  })
  await s3Client.send(putCommand)
  log.info(`Thumbnail uploaded: ${thumbnailKey}`)

  return { width: metadata.width || 0, height: metadata.height || 0 }
}

// ジョブ投入側（index.ts）と共有するペイロードの型
export type GenerateThumbnailJobData = { fileId: string }

// パターン1: サムネイル生成ジョブ（Unique制約で冪等性担保）
export async function processGenerateThumbnail(job: Job<GenerateThumbnailJobData>) {
  const { fileId } = job.data

  log.info(`Processing generate-thumbnail job ${job.id} for file: ${fileId}`)

  const thumbnailKey = `thumbnails/${fileId}.jpg`

  // 重い処理に入る前の早期スキップ（最適化）。冪等性そのものは後段の createThumbnailIfAbsent が担う。
  const existing = await prisma.thumbnail.findUnique({ where: { fileId } })
  if (existing) {
    log.info(`[${job.id}] Thumbnail already exists for file: ${fileId} (skipped by pre-check)`)
    return { status: 'already_exists' }
  }

  const file = await prisma.uploadedFile.findUnique({ where: { id: fileId } })
  if (!file) {
    log.error(`[${job.id}] Uploaded file not found, skipping: ${fileId}`)
    return { status: 'not_found' }
  }

  // 1. サムネイル生成 + S3 アップロード
  let thumbnailMeta: ThumbnailMeta
  try {
    thumbnailMeta = await generateAndUploadThumbnail(file.s3Key, thumbnailKey)
  } catch (error) {
    if (isRetryableError(error)) {
      log.warn(`[${job.id}] Retryable error during thumbnail generation: ${error}`)
      throw error
    }
    log.error(`[${job.id}] Non-retryable error, skipping: ${error}`)
    return { status: 'error', error: String(error) }
  }

  // 2. DB 保存（冪等性の核: Unique制約 = 最終ガード）
  try {
    const result = await createThumbnailIfAbsent(prisma, fileId, thumbnailKey, thumbnailMeta)
    if (result.status === 'already_exists') {
      log.info(`[${job.id}] Thumbnail already exists for file: ${fileId} (caught by core)`)
      return { status: 'already_exists' }
    }
    log.info(`Thumbnail record created for file: ${fileId}`)
    return { status: 'created', thumbnailKey }
  } catch (error) {
    if (isRetryableError(error)) {
      log.warn(`[${job.id}] Retryable error, will retry: ${error}`)
      throw error
    }
    log.error(`[${job.id}] Non-retryable error, skipping: ${error}`)
    return { status: 'error', error: String(error) }
  }
}
