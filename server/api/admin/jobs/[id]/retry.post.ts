import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { requireAdmin } from '../../../../services/session'
import { toJobDTO } from '../../../../db/queries/jobs'
import { retryGenerationJob } from '../../../../services/generation'

/**
 * 重试失败的出题任务（§8.7 32 / §10.3）：草稿或资料变化 409，重新入队后由 worker 领取。
 * 响应在任务 DTO 上追加 retriedBatches（本次重跑的批次数），旧客户端忽略该字段不受影响。
 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const jobId = readParam(event, 'id')
    const db = useDb()
    const result = retryGenerationJob(db, jobId, now)
    return ok(event, { ...toJobDTO(result.job), retriedBatches: result.retriedBatches })
  } catch (error) {
    return failFrom(event, error)
  }
})
