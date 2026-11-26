import { useDb } from '../utils/db'
import { generateRollingToday } from '../services/rolling'
import type { TaskHandle } from './deadline-sweeper'

export function startRollingSweeper(): TaskHandle {
  const tick = () => {
    try { generateRollingToday(useDb(), Date.now()) }
    catch (error) { console.error('[rolling-sweeper] 自动场次巡守失败', error) }
  }
  tick()
  const timer = setInterval(tick, 15_000)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
