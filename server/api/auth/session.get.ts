import type { SessionDTO } from '../../../shared/types/auth'
import { failFrom, ok } from '../../utils/respond'
import { clearSessionCookie, readSession } from '../../services/session'

/** 当前会话（§8.2）：始终 200，未登录返回 authenticated:false 并清理失效 Cookie */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    const session = readSession(event, now)
    if (!session) {
      clearSessionCookie(event)
      const anonymous: SessionDTO = { authenticated: false, name: null, role: null, serverNow: now }
      return ok(event, anonymous)
    }
    const payload: SessionDTO = {
      authenticated: true,
      name: session.name,
      role: session.role,
      serverNow: now,
    }
    return ok(event, payload)
  } catch (error) {
    return failFrom(event, error)
  }
})
