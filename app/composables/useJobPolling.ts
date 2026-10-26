/**
 * 出题任务轮询（契约 §10.5）：1 秒轮询 GET /api/admin/jobs/:id，
 * 只在 queued|running 时继续；结束或组件卸载即停止。
 */
import type { JobDTO, JobStatus } from '#shared/types'
import { JOB_POLL_INTERVAL_MS } from '#shared/constants'

export interface JobPollingOptions {
  intervalMs?: number
  onSettled?: (job: JobDTO) => void | Promise<void>
  onError?: (message: string) => void
}

export function isJobActive(status: JobStatus | null | undefined): boolean {
  return status === 'queued' || status === 'running'
}

export function useJobPolling(options: JobPollingOptions = {}) {
  const job = ref<JobDTO | null>(null)
  const polling = ref(false)
  const intervalMs = options.intervalMs ?? JOB_POLL_INTERVAL_MS
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
  }

  function stop(): void {
    stopped = true
    clearTimer()
    polling.value = false
  }

  function schedule(): void {
    clearTimer()
    if (stopped) return
    polling.value = true
    timer = setTimeout(() => {
      void poll()
    }, intervalMs)
  }

  async function poll(): Promise<void> {
    const current = job.value
    if (!current || stopped) return
    try {
      const next = await apiFetch<JobDTO>(`/api/admin/jobs/${current.id}`, { silent: true })
      if (stopped) return
      job.value = next
      if (isJobActive(next.status)) {
        schedule()
      } else {
        polling.value = false
        await options.onSettled?.(next)
      }
    } catch (error) {
      if (stopped) return
      options.onError?.(describeApiError(error, '获取出题进度失败'))
      // 继续轮询，避免一次网络抖动就丢失进度
      schedule()
    }
  }

  /** 开始跟踪一个任务；terminal 状态不会轮询 */
  function track(next: JobDTO | null): void {
    job.value = next
    stopped = false
    if (!next) {
      clearTimer()
      polling.value = false
      return
    }
    if (isJobActive(next.status)) schedule()
    else {
      clearTimer()
      polling.value = false
    }
  }

  /** 立即拉取一次（生成/重试后） */
  async function refresh(): Promise<void> {
    stopped = false
    await poll()
  }

  onBeforeUnmount(stop)

  return { job, polling, track, stop, refresh }
}
