import { useDb, withTransaction } from '../utils/db'
import { failInterruptedJobs } from '../db/queries/jobs'
import { startDeadlineSweeper } from '../tasks/deadline-sweeper'
import { startGenerationWorker } from '../tasks/generation-worker'
import { startRollingSweeper } from '../tasks/rolling-sweeper'

/**
 * 后台任务启动（§11.2 / §11.3）：
 * - 启动时把上一进程遗留的 running 任务标记为 INTERRUPTED 失败
 * - 截止自动交卷巡守：启动即跑一次，之后每秒
 * - 出题任务执行器：每秒原子领取一个 queued 任务
 * - 每日题库组卷巡守：启动即检查，之后每 15 秒检查
 */
export default defineNitroPlugin((nitroApp) => {
  const db = useDb()
  const interrupted = failInterruptedJobs(db, Date.now())
  withTransaction(db, () => {
    db.prepare(`UPDATE bank_generation_jobs SET status = 'failed', run_token = NULL,
      error_message = CASE WHEN plan_json IS NULL THEN '服务重启，全文梳理已中断，可重新梳理'
        ELSE '服务重启，生成已中断；已完成来源的题目已保留，可继续未完成来源' END,
      updated_at = ? WHERE status = 'running'`).run(Date.now())
  })
  if (interrupted > 0) {
    console.warn(`[tasks] ${interrupted} 个出题任务因服务重启标记为失败`)
  }

  const sweeper = startDeadlineSweeper()
  const worker = startGenerationWorker()
  const rolling = startRollingSweeper()

  nitroApp.hooks.hook('close', () => {
    sweeper.stop()
    worker.stop()
    rolling.stop()
  })
})
