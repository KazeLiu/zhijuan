import { useDb } from '../../../../utils/db'
import { ApiFailure, failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { requireAdmin } from '../../../../services/session'
import { findJob, readJobOutput } from '../../../../db/queries/jobs'
import type { JobOutputDTO } from '../../../../../shared/types/exam'

/** 解析 offset：缺省 0，非负整数，否则 400 VALIDATION_FAILED（§11.8） */
function readOffset(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === null || value === '') return 0
  if (typeof value !== 'string' || !/^\d+$/u.test(value.trim())) {
    throw new ApiFailure('VALIDATION_FAILED', 'offset 必须是非负整数')
  }
  const parsed = Number.parseInt(value.trim(), 10)
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiFailure('VALIDATION_FAILED', 'offset 必须是非负整数')
  }
  return parsed
}

/**
 * 增量读取出题任务的模型原始输出（§11.8）：管理端按 offset 轮询，
 * text 为本次新增片段，total 为当前存储总长，done 表示任务已结束。
 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const jobId = readParam(event, 'id')
    const query = getQuery(event)
    const offset = readOffset(query.offset)
    const runId = Array.isArray(query.runId) ? query.runId[0] : query.runId
    if (runId !== undefined && (typeof runId !== 'string' || runId.length > 100)) {
      throw new ApiFailure('VALIDATION_FAILED', 'runId 格式不正确')
    }
    const db = useDb()
    const job = findJob(db, jobId)
    if (!job) throw new ApiFailure('NOT_FOUND', '出题任务不存在')
    const slice = readJobOutput(db, jobId, offset, runId)
    const payload: JobOutputDTO = {
      text: slice?.text ?? '',
      offset: slice?.offset ?? offset,
      total: slice?.total ?? 0,
      done: job.status === 'succeeded' || job.status === 'failed',
      truncated: slice?.truncated ?? 0,
      runId: slice?.runId,
      startOffset: slice?.startOffset,
    }
    return ok(event, payload)
  } catch (error) {
    return failFrom(event, error)
  }
})
