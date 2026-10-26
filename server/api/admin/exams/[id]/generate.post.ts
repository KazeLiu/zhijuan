import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { readJsonObject } from '../../../../utils/validate'
import { requireAdmin } from '../../../../services/session'
import { toJobDTO } from '../../../../db/queries/jobs'
import { createGenerationJob } from '../../../../services/generation'

/** 发起出题任务（§8.5 23）：校验通过后入队 202，实际执行由后台 worker 领取 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const body = await readJsonObject(event)
    const db = useDb()
    const job = createGenerationJob(db, examId, body, now)
    return ok(event, toJobDTO(job), 202)
  } catch (error) {
    return failFrom(event, error)
  }
})
