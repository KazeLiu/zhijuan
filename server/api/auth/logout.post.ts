import type { LogoutResultDTO } from '../../../shared/types/auth'
import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { clearSessionCookie, deleteSessionRow, readSession } from '../../services/session'

/** 登出（§8.2）：删会话行并清 Cookie，重复调用幂等 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const db = useDb()
    const session = readSession(event, now)
    if (session) deleteSessionRow(db, session.id)
    clearSessionCookie(event)
    const payload: LogoutResultDTO = { ok: true }
    return ok(event, payload)
  } catch (error) {
    return failFrom(event, error)
  }
})
