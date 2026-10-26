import type { LoginResultDTO } from '../../../shared/types/auth'
import { useDb } from '../../utils/db'
import { failFrom, ok } from '../../utils/respond'
import { readJsonObject } from '../../utils/validate'
import { createSessionRow, landingFor, normalizeName, resolveRole, setSessionCookie } from '../../services/session'

/** 姓名登录（§8.2）：姓名即身份，写会话并返回落地页 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    const body = await readJsonObject(event)
    const name = normalizeName(body.name)
    const db = useDb()
    const session = createSessionRow(db, name, now)
    setSessionCookie(event, session.id, session.expiresAt)
    const role = resolveRole(name)
    const payload: LoginResultDTO = {
      authenticated: true,
      name,
      role,
      landing: landingFor(db, name, role, now),
      serverNow: now,
    }
    return ok(event, payload)
  } catch (error) {
    return failFrom(event, error)
  }
})
