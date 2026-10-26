import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { refreshModels } from '../../../services/settings'

/** 拉取模型列表（§8.4 14）：GET {baseUrl}/models，不改已选模型 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const db = useDb()
    return ok(event, await refreshModels(db))
  } catch (error) {
    return failFrom(event, error)
  }
})
