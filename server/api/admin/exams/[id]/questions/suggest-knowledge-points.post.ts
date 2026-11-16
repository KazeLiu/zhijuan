import { useDb } from '../../../../../utils/db'
import { ApiFailure, failFrom, ok } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { readOptionalJsonObject } from '../../../../../utils/validate'
import { requireAdmin } from '../../../../../services/session'
import { suggestKnowledgePoints } from '../../../../../services/bank-suggest'

/**
 * 为题目建议知识点（契约 §4.1）：body 可省略（等价全卷题目）。
 * 降级不报错：模型未配置/调用失败时返回 degraded=true + 兜底知识点 + 中文 message。
 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const body = await readOptionalJsonObject(event)
    const rawIds = body.questionIds
    let questionIds: string[] | undefined
    if (rawIds !== undefined) {
      if (!Array.isArray(rawIds) || !rawIds.every((id) => typeof id === 'string' && id !== '')) {
        throw new ApiFailure('VALIDATION_FAILED', '题目 id 列表格式不正确', {
          fields: { questionIds: '必须是非空字符串数组' },
        })
      }
      questionIds = rawIds as string[]
    }
    return ok(event, await suggestKnowledgePoints(useDb(), examId, questionIds))
  } catch (error) {
    return failFrom(event, error)
  }
})
