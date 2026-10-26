import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { requireAdmin } from '../../../../services/session'
import { toJobDTO } from '../../../../db/queries/jobs'
import { retryGenerationJob } from '../../../../services/generation'

/** 重试失败的出题任务（§8.7 32）：草稿或资料变化 409，重新入队后由 worker 领取 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const jobId = readParam(event, 'id')
    const db = useDb()
    return ok(event, toJobDTO(retryGenerationJob(db, jobId, now)))
  } catch (error) {
    return failFrom(event, error)
  }
})
