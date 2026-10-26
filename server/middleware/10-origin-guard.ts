import type { H3Event } from 'h3'
import { fail } from '../utils/respond'

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 写请求同源校验（§5.4）：带 Origin 头时其 host 必须与 Host 头一致。
 * 无 Origin（脚本 / curl / 同源 fetch 的部分场景）放行，不引入额外令牌机制。
 */
function checkOrigin(event: H3Event): { origin: string; host: string } | null {
  const method = (event.method || 'GET').toUpperCase()
  if (!UNSAFE_METHODS.has(method)) return null

  const origin = getHeader(event, 'origin')
  if (!origin) return null

  const host = getHeader(event, 'host')
  if (!host) return { origin, host: '' }

  let originHost = ''
  try {
    originHost = new URL(origin).host
  } catch {
    originHost = ''
  }
  if (originHost === host) return null
  return { origin, host }
}

export default defineEventHandler((event) => {
  if (!event.path.startsWith('/api/')) return
  const mismatch = checkOrigin(event)
  if (!mismatch) return
  return fail(event, 'CSRF_ORIGIN_REJECTED', '请求来源校验失败，请通过本站页面操作')
})
