import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import { processSweepStuckArchives } from '../workers/sweeper.js'
import { testDatabaseUrl } from './test-db.js'

// テスト用Prismaクライアント（テスト専用 DB の app_test に接続する）
const pool = new pg.Pool({ connectionString: testDatabaseUrl() })
const adapter = new PrismaPg(pool)
const prisma = new PrismaClient({ adapter })

// enqueue の差し替え: 実際のキューには投入せず、呼ばれた archiveId を記録する
function createEnqueueRecorder() {
  const enqueued: string[] = []
  return {
    enqueued,
    enqueue: (archiveId: string) => {
      enqueued.push(archiveId)
      return Promise.resolve()
    },
  }
}

async function createArchive(status: 'PENDING' | 'PROCESSING' | 'COMPLETED', startedAt: Date | null) {
  return prisma.archive.create({
    data: {
      s3Key: `archives/sweeper-test-${crypto.randomUUID()}.zip`,
      fileCount: 0,
      status,
      startedAt,
    },
  })
}

const MINUTES = 60 * 1000

describe('回収ジョブ（stuck アーカイブの回復）', () => {
  beforeEach(async () => {
    await prisma.archiveFile.deleteMany()
    await prisma.archive.deleteMany()
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pool.end()
  })

  it('閾値より古い PROCESSING は PENDING に戻り、ジョブが再投入される', async () => {
    const stuck = await createArchive('PROCESSING', new Date(Date.now() - 10 * MINUTES))
    const { enqueued, enqueue } = createEnqueueRecorder()

    const result = await processSweepStuckArchives(prisma, enqueue)

    expect(result.recovered).toBe(1)
    expect(enqueued).toEqual([stuck.id])
    const after = await prisma.archive.findUniqueOrThrow({ where: { id: stuck.id } })
    expect(after.status).toBe('PENDING')
  })

  it('閾値より新しい PROCESSING（処理中の可能性が高い）には手を出さない', async () => {
    const active = await createArchive('PROCESSING', new Date())
    const { enqueued, enqueue } = createEnqueueRecorder()

    const result = await processSweepStuckArchives(prisma, enqueue)

    expect(result.recovered).toBe(0)
    expect(enqueued).toEqual([])
    const after = await prisma.archive.findUniqueOrThrow({ where: { id: active.id } })
    expect(after.status).toBe('PROCESSING')
  })

  it('PENDING と COMPLETED は古くても対象外', async () => {
    const old = new Date(Date.now() - 10 * MINUTES)
    await createArchive('PENDING', null)
    await createArchive('COMPLETED', old)
    const { enqueued, enqueue } = createEnqueueRecorder()

    const result = await processSweepStuckArchives(prisma, enqueue)

    expect(result.recovered).toBe(0)
    expect(enqueued).toEqual([])
  })

  it('複数の stuck があれば全件回復する', async () => {
    const old = new Date(Date.now() - 10 * MINUTES)
    const a = await createArchive('PROCESSING', old)
    const b = await createArchive('PROCESSING', old)
    const { enqueued, enqueue } = createEnqueueRecorder()

    const result = await processSweepStuckArchives(prisma, enqueue)

    expect(result.recovered).toBe(2)
    expect(enqueued.sort()).toEqual([a.id, b.id].sort())
  })
})
