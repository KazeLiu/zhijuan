import { useDb } from '../utils/db'
import { failInterruptedJobs } from '../db/queries/jobs'
import { startDeadlineSweeper } from '../tasks/deadline-sweeper'
import { startGenerationWorker } from '../tasks/generation-worker'

/**
 * 后台任务启动（§11.2 / §11.3）：
 * - 启动时把上一进程遗留的 running 任务标记为 INTERRUPTED 失败
 * - 截止自动交卷巡守：启动即跑一次，之后每秒
 * - 出题任务执行器：每秒原子领取一个 queued 任务
 */
export default defineNitroPlugin((nitroApp) => {
  const db = useDb()
  const interrupted = failInterruptedJobs(db, Date.now())
  if (interrupted > 0) {
    console.warn(`[tasks] ${interrupted} 个出题任务因服务重启标记为失败`)
  }

  const sweeper = startDeadlineSweeper()
  const worker = startGenerationWorker()

  nitroApp.hooks.hook('close', () => {
    sweeper.stop()
    worker.stop()
  })
})
