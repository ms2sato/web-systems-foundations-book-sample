import { Queue } from 'bullmq'
import { Redis } from 'ioredis'

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'

// キューと Worker で共有する Redis 接続（BullMQ の要件で maxRetriesPerRequest は null）
export const redisConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null })

// ジョブの再試行はキュー側の既定として一元管理する
export const jobQueue = new Queue('jobs', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },
})
