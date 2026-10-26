import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { H3Event } from 'h3'
import { DEFAULT_SESSION_TTL_DAYS, MAX_NAME_LENGTH } from '../../shared/constants'
import type { Role } from '../../shared/types/common'
import { findAttemptByName } from '../db/queries/attempts'
import { findLatestClosedExam, findOpenExam } from '../db/queries/exams'
import { ApiFailure } from '../utils/respond'

/** 已认证的会话（role 每次请求实时计算，不入库） */
export interface SessionInfo {
  id: string
  name: string
  role: Role
}

/** 姓名规范化唯一实现（§5.1）：NFC + trim，长度 1..64 码点，保留大小写 */
export function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiFailure('INVALID_NAME', '姓名必须是文本')
  }
  const name = raw.normalize('NFC').trim()
  const length = Array.from(name).length
  if (length < 1) {
    throw new ApiFailure('INVALID_NAME', '姓名不能为空')
  }
  if (length > MAX_NAME_LENGTH) {
    throw new ApiFailure('INVALID_NAME', `姓名不能超过 ${MAX_NAME_LENGTH} 个字符`)
  }
  return name
}

/** 管理员名单：runtimeConfig.adminNames（可能是数组或 JSON 字符串），每次请求实时读取 */
export function adminNames(): string[] {
  const raw = useRuntimeConfig().adminNames as unknown
  let list: string[] = []
  if (Array.isArray(raw)) {
    list = raw.filter((item): item is string => typeof item === 'string')
  } else if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) list = parsed.filter((item): item is string => typeof item === 'string')
    } catch {
      list = raw.split(',')
    }
  }
  const normalized: string[] = []
  for (const item of list) {
    try {
      normalized.push(normalizeName(item))
    } catch {
      // 名单里的非法条目直接忽略，不影响其他管理员
    }
  }
  return normalized
}

/** 角色判定：与名单任一项全等（NFC 规范化后）即管理员 */
export function resolveRole(name: string): Role {
  const key = normalizeName(name)
  return adminNames().includes(key) ? 'admin' : 'candidate'
}

function sessionTtlDays(): number {
  const raw = useRuntimeConfig().sessionTtlDays as unknown
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SESSION_TTL_DAYS
}

function sessionCookieName(): string {
  const raw = useRuntimeConfig().sessionCookieName as unknown
  return typeof raw === 'string' && raw !== '' ? raw : 'zj_session'
}

interface SessionRow {
  id: string
  name: string
  name_key: string
  created_at: number
  expires_at: number
}

/** 新建会话行：43 字符 base64url 随机 ID（§5.2） */
export function createSessionRow(
  db: DatabaseSync,
  name: string,
  now: number,
): { id: string; expiresAt: number } {
  const id = randomBytes(32).toString('base64url')
  const expiresAt = now + sessionTtlDays() * 86_400_000
  db.prepare('INSERT INTO sessions (id, name, name_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    name,
    name,
    now,
    expiresAt,
  )
  return { id, expiresAt }
}

export function deleteSessionRow(db: DatabaseSync, sessionId: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
}

/** 读会话行；过期即删除并视为未登录（不滑动续期） */
export function findSessionRow(db: DatabaseSync, sessionId: string, now: number): SessionRow | undefined {
  const row = db
    .prepare('SELECT id, name, name_key, created_at, expires_at FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined
  if (!row) return undefined
  if (Number(row.expires_at) <= now) {
    deleteSessionRow(db, sessionId)
    return undefined
  }
  return row
}

/** 是否 HTTPS（决定 Cookie 是否加 Secure） */
function isSecureRequest(event: H3Event): boolean {
  const forwarded = getHeader(event, 'x-forwarded-proto')
  if (typeof forwarded === 'string' && forwarded.split(',')[0]?.trim().toLowerCase() === 'https') return true
  const encrypted = (event.node.req.socket as { encrypted?: boolean } | undefined)?.encrypted
  return encrypted === true
}

export function setSessionCookie(event: H3Event, sessionId: string, expiresAt: number): void {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  setCookie(event, sessionCookieName(), sessionId, {
    httpOnly: true,
    path: '/',
    sameSite: 'strict',
    maxAge,
    secure: isSecureRequest(event),
  })
}

export function clearSessionCookie(event: H3Event): void {
  setCookie(event, sessionCookieName(), '', {
    httpOnly: true,
    path: '/',
    sameSite: 'strict',
    maxAge: 0,
    secure: isSecureRequest(event),
  })
}

/** 解析当前会话；无 Cookie / 行不存在 / 已过期 → null（顺带清 Cookie 由调用方决定） */
export function readSession(event: H3Event, now: number): SessionInfo | null {
  const db = useDb()
  const cookie = getCookie(event, sessionCookieName())
  if (!cookie) return null
  const row = findSessionRow(db, cookie, now)
  if (!row) return null
  return { id: row.id, name: row.name_key, role: resolveRole(row.name_key) }
}

/** 需要登录：失败 401 UNAUTHORIZED */
export function requireSession(event: H3Event, now: number): SessionInfo {
  const session = readSession(event, now)
  if (!session) throw new ApiFailure('UNAUTHORIZED', '请先登录')
  return session
}

/** 需要管理员：无会话 401，有会话非管理员 403 */
export function requireAdmin(event: H3Event, now: number): SessionInfo {
  const session = requireSession(event, now)
  if (session.role !== 'admin') throw new ApiFailure('FORBIDDEN', '需要管理员权限')
  return session
}

/**
 * 登录后落地页（§8.2）：管理员 → /admin；考生按开放场次与本人答卷决定。
 * 无开放场次时回落到最近结束场次的成绩页，再退回首页。
 */
export function landingFor(db: DatabaseSync, name: string, role: Role, now: number): string {
  if (role === 'admin') return '/admin'
  const openExam = findOpenExam(db, now)
  if (openExam) {
    const attempt = findAttemptByName(db, openExam.id, name)
    if (!attempt) return `/exams/${openExam.id}/attempt`
    if (attempt.status === 'submitted') return `/attempts/${attempt.id}/result`
    return `/exams/${openExam.id}/attempt`
  }
  const closedExam = findLatestClosedExam(db, now)
  if (closedExam) {
    const attempt = findAttemptByName(db, closedExam.id, name)
    if (attempt?.status === 'submitted') return `/attempts/${attempt.id}/result`
  }
  return '/'
}
