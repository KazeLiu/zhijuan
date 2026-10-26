import { useDb } from '../utils/db'
import { claimNextQueuedJob } from '../db/queries/jobs'
import { findProviderSettings } from '../db/queries/settings'
import { executeGenerationJob } from '../services/generation'
import type { TaskHandle } from './deadline-sweeper'

const WORKER_INTERVAL_MS = 1000

/**
 * 出题任务执行器（§11.2）：每秒尝试原子领取一个 queued 任务。
 * 同一时刻只跑一个任务，保证单进程串行调用模型。
 */
export function startGenerationWorker(intervalMs = WORKER_INTERVAL_MS): TaskHandle {
  let busy = false
  const tick = async (): Promise<void> => {
    if (busy) return
    busy = true
    try {
      const db = useDb()
      const now = Date.now()
      const settings = findProviderSettings(db)
      const jobId = claimNextQueuedJob(db, {
        modelId: settings.modelId ?? '',
        baseUrl: settings.baseUrl,
        now,
      })
      if (!jobId) return
      await executeGenerationJob(db, jobId)
    } catch (error) {
      console.error('[generation-worker] 任务执行失败', error)
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, intervalMs)
  timer.unref()
  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}
