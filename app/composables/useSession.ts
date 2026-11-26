/**
 * 会话状态（契约 §8.2 / §10.7）：
 * 会话以 `GET /api/auth/session` 为准，本 composable 只缓存最近一次结果供布局/页面共享。
 */
import type { LoginRequest, LoginResultDTO, SessionDTO } from '#shared/types'

export function useAuthSession() {
  const session = useState<SessionDTO | null>('zj.session', () => null)
  const loading = useState<boolean>('zj.session.loading', () => false)
  const sessionError = useState<string | null>('zj.session.error', () => null)

  /** 读取服务端会话（不抛错，失败时返回 null 并记录错误文案） */
  async function refresh(): Promise<SessionDTO | null> {
    loading.value = true
    try {
      const data = await apiFetch<SessionDTO>('/api/auth/session', { silent: true })
      session.value = data
      sessionError.value = null
      return data
    } catch (error) {
      sessionError.value = describeApiError(error, '无法获取登录状态')
      return null
    } finally {
      loading.value = false
    }
  }

  /** 姓名即身份：成功即写入会话缓存，管理员按服务端 landing 跳转。 */
  async function login(name: string): Promise<LoginResultDTO> {
    const payload: LoginRequest = { name }
    const result = await apiFetch<LoginResultDTO>('/api/auth/login', {
      method: 'POST',
      body: payload,
      silent: true,
    })
    session.value = {
      authenticated: true,
      name: result.name,
      role: result.role,
      serverNow: result.serverNow,
    }
    if (result.role === 'admin') await navigateTo(result.landing)
    return result
  }

  async function logout(): Promise<void> {
    try {
      await apiFetch<{ ok: true }>('/api/auth/logout', { method: 'POST', silent: true })
    } catch {
      // 会话可能已失效，登出失败不影响本地清理
    } finally {
      session.value = null
    }
  }

  return { session, loading, sessionError, refresh, login, logout }
}
