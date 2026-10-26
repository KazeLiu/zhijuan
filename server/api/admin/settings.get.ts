import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { requireAdmin } from '../../services/session'
import { loadSettings } from '../../services/settings'

/** 读取模型设置（§8.4 12）：永不返回 apiKey */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const db = useDb()
    return ok(event, loadSettings(db))
  } catch (error) {
    return failFrom(event, error)
  }
})
