/**
 * 服务端时钟偏移校准（契约 §10.3）：
 * offset = serverNow - Date.now()，显示时刻 = Date.now() + offset。
 * 正计时只依赖该时钟，页面上不显示倒计时。
 */
import type { EpochMs } from '#shared/types'

export function useServerClock(initialServerNow?: EpochMs) {
  const offset = ref(0)
  const now = ref(Date.now())
  let timer: ReturnType<typeof setInterval> | null = null

  function tick(): void {
    now.value = Date.now() + offset.value
  }

  /** 用一次接口响应里的 serverNow 校准客户端时钟 */
  function sync(serverNow: EpochMs | null | undefined): void {
    if (serverNow === null || serverNow === undefined || !Number.isFinite(serverNow)) return
    offset.value = serverNow - Date.now()
    tick()
  }

  function start(intervalMs = 500): void {
    stop()
    tick()
    timer = setInterval(tick, intervalMs)
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  onBeforeUnmount(stop)

  if (initialServerNow !== undefined) sync(initialServerNow)

  return { now, offset, sync, start, stop }
}
