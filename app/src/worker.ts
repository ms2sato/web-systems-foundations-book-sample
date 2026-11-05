import { Worker, Job } from 'bullmq'
import { redisConnection } from './lib/queue.js'
import { log } from './lib/log.js'
import { processGenerateThumbnail } from './workers/thumbnail.js'
import { processCreateArchive } from './workers/archive.js'
import { processSweepStuckArchives } from './workers/sweeper.js'

const worker = new Worker(
  'jobs',
  async (job: Job) => {
    log.info(`Processing job ${job.id}: ${job.name}`)

    if (job.name === 'generate-thumbnail') {
      return processGenerateThumbnail(job)
    }
    if (job.name === 'create-archive') {
      return processCreateArchive(job)
    }
    if (job.name === 'sweep-stuck-archives') {
      return processSweepStuckArchives()
    }

    throw new Error(`Unknown job type: ${job.name}`)
  },
  { connection: redisConnection }
)

worker.on('completed', (job) => {
  log.info(`Job ${job.id} completed`)
})

// failed イベントは失敗のたびに発火する。リトライが残っていれば WARN に留め、
// 使い切った失敗だけを ERROR にする（エラー監視で「対応が必要な失敗」だけが光るように）
worker.on('failed', (job, err) => {
  const attemptsExhausted = job !== undefined && job.attemptsMade >= (job.opts.attempts ?? 1)
  if (attemptsExhausted) {
    log.error(`Job ${job.id} failed permanently (attempts exhausted):`, err)
  } else {
    log.warn(`Job ${job?.id} failed (will retry): ${err.message}`)
  }
})

log.info(`Worker started, waiting for jobs...`)

/**
 * 停止シグナル（SIGTERM/SIGINT）を受けたら、実行中のジョブを終えてから止まる。
 * これを書かないと Node は SIGTERM でも即終了し、処理中の Archive が
 * PROCESSING のまま残る
 * （それでも SIGKILL や電源断は防げず、回収ジョブが担う）
 * @see https://docs.bullmq.io/guide/workers/graceful-shutdown
 */
const shutdown = async (signal: string) => {
  log.info(`${signal} received, waiting for active jobs to finish...`)
  await worker.close()
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
