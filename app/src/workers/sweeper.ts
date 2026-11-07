import type { PrismaClient } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { jobQueue } from '../lib/queue.js'
import { log } from '../lib/log.js'
import type { CreateArchiveJobData } from './archive.js'

// PROCESSING のままこの時間を超えた Archive は「担当ワーカーが死んだ」とみなす。
// 正常な処理がこれより長くかかると誤って処理権を奪い直してしまうため、
// 実際の処理時間に対して十分な余裕を持たせること（このデモの ZIP 作成は数秒で終わる）
const STUCK_THRESHOLD_MINUTES = 2

async function enqueueCreateArchive(archiveId: string): Promise<void> {
  await jobQueue.add('create-archive', { archiveId } satisfies CreateArchiveJobData)
}

// 定時実行される回収ジョブ:
// 長時間 PROCESSING のままの Archive を PENDING に戻し、ジョブを投入し直す。
// ワーカーの急死などで宙に浮いた処理は、状態フラグだけでは誰にも救われない。
// 「DB の状態を正として定期的に見回る」ことで、原因が何であれ回復できる。
// client と enqueue を差し替えられるのはテストのため
export async function processSweepStuckArchives(
  client: PrismaClient = prisma,
  enqueue: (archiveId: string) => Promise<void> = enqueueCreateArchive
) {
  try {
    const threshold = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000)
    // 「探す」と「戻す」を1文（UPDATE ... RETURNING）で行い、戻した行を受け取る
    const recovered = await client.archive.updateManyAndReturn({
      where: { status: 'PROCESSING', startedAt: { lt: threshold } },
      data: { status: 'PENDING' },
    })

    for (const archive of recovered) {
      await enqueue(archive.id)
      log.info(`Recovered stuck archive: ${archive.id} (startedAt: ${archive.startedAt?.toISOString()})`)
    }
    return { status: 'completed', recovered: recovered.length }
  } catch (error) {
    // 回復係自体の故障は、普通のジョブ失敗より深刻（stuck が誰にも救われなくなる）。
    // この log.error は、実務ではエラー監視サービスへの通知に置き換わる想定
    log.error('Sweeper failed — 回収ジョブによる自動回復が機能していない:', error)
    throw error // 握りつぶさない。キュー上も failed として記録を残す
  }
}
