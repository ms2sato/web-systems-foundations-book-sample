import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import { createThumbnailIfAbsent } from '../workers/thumbnail.js'
import { claimArchive } from '../workers/archive.js'
import { isRetryableError } from '../lib/errors.js'
import { testDatabaseUrl } from './test-db.js'

// テスト用Prismaクライアント（テスト専用 DB の app_test に接続する）
const pool = new pg.Pool({ connectionString: testDatabaseUrl() })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

describe('ジョブの冪等性テスト', () => {
  beforeAll(async () => {
    // テスト前にDBをクリーン
    await prisma.archiveFile.deleteMany()
    await prisma.archive.deleteMany()
    await prisma.thumbnail.deleteMany()
    await prisma.uploadedFile.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pool.end()
  })

  describe('パターン1: Unique制約による冪等性（サムネイル生成）', () => {
    let testFile: { id: string; s3Key: string }

    beforeEach(async () => {
      // テスト用ファイルを作成
      testFile = await prisma.uploadedFile.create({
        data: {
          s3Key: `test-${Date.now()}.jpg`,
          originalName: 'test.jpg',
          contentType: 'image/jpeg',
          size: 1000,
        },
      })
    })

    it('同じfileIdに対して2回サムネイル作成を試みても、DBには1件だけ登録される', async () => {
      const fileId = testFile.id

      // 1回目: サムネイル作成成功
      const result1 = await createThumbnailIfAbsent(prisma, fileId, 'thumbnails/thumb1.jpg', { width: 200, height: 150 })
      expect(result1.status).toBe('created')

      // 2回目: Unique制約違反で「既に存在」
      const result2 = await createThumbnailIfAbsent(prisma, fileId, 'thumbnails/thumb2.jpg', { width: 200, height: 150 })
      expect(result2.status).toBe('already_exists')

      // DBには1件だけ
      const count = await prisma.thumbnail.count({ where: { fileId } })
      expect(count).toBe(1)
    })

    it('異なるfileIdなら別々にサムネイルが作成される', async () => {
      // 別のテストファイルを作成
      const testFile2 = await prisma.uploadedFile.create({
        data: {
          s3Key: `test2-${Date.now()}.jpg`,
          originalName: 'test2.jpg',
          contentType: 'image/jpeg',
          size: 1000,
        },
      })

      const result1 = await createThumbnailIfAbsent(prisma, testFile.id, `thumbnails/${testFile.id}.jpg`, { width: 200, height: 150 })
      const result2 = await createThumbnailIfAbsent(prisma, testFile2.id, `thumbnails/${testFile2.id}.jpg`, { width: 200, height: 150 })

      expect(result1.status).toBe('created')
      expect(result2.status).toBe('created')

      const count = await prisma.thumbnail.count()
      expect(count).toBeGreaterThanOrEqual(2)
    })

    it('決定論的key: 同じfileIdなら何度試みても同じs3Keyで1件に収束する', async () => {
      const fileId = testFile.id
      // worker.ts と同じ決定論的key: `thumbnails/${fileId}.jpg`
      const deterministicKey = `thumbnails/${fileId}.jpg`

      const result1 = await createThumbnailIfAbsent(prisma, fileId, deterministicKey, { width: 200, height: 150 })
      const result2 = await createThumbnailIfAbsent(prisma, fileId, deterministicKey, { width: 200, height: 150 })

      expect(result1.status).toBe('created')
      expect(result2.status).toBe('already_exists')

      const records = await prisma.thumbnail.findMany({ where: { fileId } })
      expect(records).toHaveLength(1)
      expect(records[0].s3Key).toBe(deterministicKey)
    })

    it('同時実行（先行SELECTをすり抜けた想定）でも Unique制約が最終ガードになり1件に収束する', async () => {
      const fileId = testFile.id
      const deterministicKey = `thumbnails/${fileId}.jpg`

      // 2件の INSERT を並列に投げる（先行SELECTがあっても TOCTOU で
      // すり抜ける可能性をシミュレートする）
      const results = await Promise.all([
        createThumbnailIfAbsent(prisma, fileId, deterministicKey, { width: 200, height: 150 }),
        createThumbnailIfAbsent(prisma, fileId, deterministicKey, { width: 200, height: 150 }),
      ])

      const statuses = results.map(r => r.status).sort()
      expect(statuses).toEqual(['already_exists', 'created'])

      const count = await prisma.thumbnail.count({ where: { fileId } })
      expect(count).toBe(1)
    })
  })

  describe('パターン2: 状態フラグ+ロックによる冪等性（アーカイブ作成）', () => {
    let testFiles: { id: string }[]

    beforeEach(async () => {
      // テスト用ファイルを作成
      testFiles = await Promise.all([
        prisma.uploadedFile.create({
          data: {
            s3Key: `archive-test-${Date.now()}-1.jpg`,
            originalName: 'file1.jpg',
            contentType: 'image/jpeg',
            size: 1000,
          },
        }),
        prisma.uploadedFile.create({
          data: {
            s3Key: `archive-test-${Date.now()}-2.jpg`,
            originalName: 'file2.jpg',
            contentType: 'image/jpeg',
            size: 2000,
          },
        }),
      ])
    })

    it('PENDING状態のアーカイブのみ処理される', async () => {
      const archive = await prisma.archive.create({
        data: {
          s3Key: `archives/test-${Date.now()}.zip`,
          fileCount: 2,
          status: 'PENDING',
          files: {
            create: testFiles.map(f => ({ fileId: f.id })),
          },
        },
      })

      // 1回目: PENDING → PROCESSING に遷移成功
      const result1 = await claimArchive(prisma, archive.id)
      expect(result1.status).toBe('claimed')
      if (result1.status !== 'claimed') {
        throw new Error('unreachable')
      }
      expect(result1.archive.status).toBe('PROCESSING')

      // 2回目: 既にPROCESSINGなのでスキップ
      const result2 = await claimArchive(prisma, archive.id)
      expect(result2.status).toBe('skipped')
    })

    it('COMPLETED状態のアーカイブは処理されない', async () => {
      const archive = await prisma.archive.create({
        data: {
          s3Key: `archives/completed-${Date.now()}.zip`,
          fileCount: 2,
          status: 'COMPLETED',
          completedAt: new Date(),
          size: 1000,
          files: {
            create: testFiles.map(f => ({ fileId: f.id })),
          },
        },
      })

      const result = await claimArchive(prisma, archive.id)
      expect(result.status).toBe('skipped')
    })

    it('FAILED状態のアーカイブは処理されない', async () => {
      const archive = await prisma.archive.create({
        data: {
          s3Key: `archives/failed-${Date.now()}.zip`,
          fileCount: 2,
          status: 'FAILED',
          failedAt: new Date(),
          errorMessage: 'Test error',
          files: {
            create: testFiles.map(f => ({ fileId: f.id })),
          },
        },
      })

      const result = await claimArchive(prisma, archive.id)
      expect(result.status).toBe('skipped')
    })

    it('存在しないアーカイブIDはnot_foundを返す', async () => {
      const result = await claimArchive(prisma, 'non-existent-id')
      expect(result.status).toBe('not_found')
    })

    it('ロック保持中の claim は SQLSTATE 55P03 で失敗し、リトライ可能と分類される', async () => {
      const archive = await prisma.archive.create({
        data: {
          s3Key: `archives/lock-test-${Date.now()}.zip`,
          fileCount: 0,
          status: 'PENDING',
        },
      })
      const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

      // 別トランザクションが行ロックを保持している間に claim を試みる
      const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT * FROM "Archive" WHERE id = ${archive.id} FOR UPDATE`
        await sleep(500)
      })
      await sleep(150)

      let caught: unknown
      try {
        await claimArchive(prisma, archive.id)
      } catch (error) {
        caught = error
      }
      await holder

      // NOWAIT により待たずに失敗し、リトライ可能と分類される
      expect(caught).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
      expect(isRetryableError(caught)).toBe(true)

      // ロックが解放された後は普通に claim できる
      const result = await claimArchive(prisma, archive.id)
      expect(result.status).toBe('claimed')
    })
  })
})
