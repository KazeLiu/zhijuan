import { useDb } from '../utils/db'
import { sweepExpiredAttempts } from '../services/attempts'

export interface TaskHandle {
  stop: () => void
}

const SWEEP_INTERVAL_MS = 1000

/**
 * 截止自动交卷巡守（§11.3）：启动即跑一次，之后每秒扫描一次。
 * 单进程内只应启动一个实例（由 server/plugins/tasks.ts 负责）。
 */
export function startDeadlineSweeper(intervalMs = SWEEP_INTERVAL_MS): TaskHandle {
  let running = false
  const tick = (): void => {
    if (running) return
    running = true
    try {
      const settled = sweepExpiredAttempts(useDb(), Date.now())
      if (settled > 0) console.info(`[deadline-sweeper] 已自动交卷 ${settled} 份`)
    } catch (error) {
      console.error('[deadline-sweeper] 截止结算失败', error)
    } finally {
      running = false
    }
  }

  tick()
  const timer = setInterval(tick, intervalMs)
  timer.unref()
  return {
    stop: () => {
      clearInterval(timer)
    },
  }
}
