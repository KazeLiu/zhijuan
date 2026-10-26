import type { DatabaseSync } from 'node:sqlite'
import { appendJobOutput } from '../db/queries/jobs'

/**
 * 模型输出落库的节流参数。
 * 流式响应每秒可能产生上千个 delta 片段，逐条 UPDATE 会把 CPU 全耗在 SQLite 上，
 * 因此先在内存累积，再按「间隔」或「累积量」批量写入。
 */
const FLUSH_INTERVAL_MS = 400
const FLUSH_THRESHOLD_CHARS = 2000

export interface JobOutputWriter {
  /** 追加一段输出（只进内存，按节流规则落库） */
  push: (chunk: string) => void
  /** 立即落库（成功/失败/finally 路径都要调，避免最后一段丢失） */
  flush: () => void
  /** 停止定时器并落库 */
  dispose: () => void
}

/**
 * 出题任务的模型原始输出写入器（§11.8）：内存累积 + 节流批量落库。
 * 写库失败只记日志，绝不因为「展示用输出」而中断真正的出题任务。
 */
export function createJobOutputWriter(db: DatabaseSync, jobId: string): JobOutputWriter {
  let buffer: string[] = []
  let buffered = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const write = (): void => {
    if (buffer.length === 0) return
    const text = buffer.join('')
    buffer = []
    buffered = 0
    try {
      appendJobOutput(db, jobId, text)
    } catch (error) {
      console.warn('[job-output] 模型输出落库失败（已忽略，不影响出题任务）', error)
    }
  }

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    write()
  }

  const push = (chunk: string): void => {
    if (disposed || chunk === '') return
    buffer.push(chunk)
    buffered += chunk.length
    if (buffered >= FLUSH_THRESHOLD_CHARS) {
      flush()
      return
    }
    if (timer === null) {
      const handle = setTimeout(() => {
        timer = null
        write()
      }, FLUSH_INTERVAL_MS)
      // 后台定时器不阻止进程退出（服务关闭时由 finally 的 dispose 兜底落库）
      const unrefable = handle as unknown as { unref?: () => void }
      if (typeof unrefable.unref === 'function') unrefable.unref()
      timer = handle
    }
  }

  const dispose = (): void => {
    flush()
    disposed = true
  }

  return { push, flush, dispose }
}
