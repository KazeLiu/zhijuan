import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { readJsonObject } from '../../utils/validate'
import { requireAdmin } from '../../services/session'
import { updateSettings } from '../../services/settings'

/** 更新模型设置（§8.4 13）：apiKey undefined 保持、null 清除、非空替换 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const body = await readJsonObject(event)
    const db = useDb()
    return ok(event, updateSettings(db, body, now))
  } catch (error) {
    return failFrom(event, error)
  }
})
