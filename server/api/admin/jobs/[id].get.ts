import { useDb } from '../../../utils/db'
import { ApiFailure, failFrom, ok } from '../../../utils/respond'
import { readParam } from '../../../utils/params'
import { requireAdmin } from '../../../services/session'
import { findJob, toJobDTO } from '../../../db/queries/jobs'

/** 查询出题任务（§8.7 31）：轮询用，含进度与失败原因 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const jobId = readParam(event, 'id')
    const db = useDb()
    const job = findJob(db, jobId)
    if (!job) throw new ApiFailure('NOT_FOUND', '出题任务不存在')
    return ok(event, toJobDTO(job))
  } catch (error) {
    return failFrom(event, error)
  }
})
