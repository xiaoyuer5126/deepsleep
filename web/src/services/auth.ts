import { create } from 'zustand'
import { requestJson, UNAUTHORIZED_EVENT } from './api/backend.js'
import type { PricingConfig } from './pricing.js'
import { resetChatStore } from './chat/store.js'

/** 账号信息：API Key 绑定在账号上，多端登录共用。 */
export type AccountUser = {
  id: string
  username: string
  createdAt?: number
  /** 是否已绑定自己的 API Key */
  hasApiKey: boolean
  /** 已绑定时的掩码，如 sk-****abcd */
  apiKeyMasked: string
  /** 未绑定但服务器配置了默认 Key */
  usingServerApiKey: boolean
  serverApiKeyAvailable?: boolean
}

export type PublicConfig = {
  allowRegistration: boolean
  requireInviteCode: boolean
  hasDefaultApiKey: boolean
  sessionDays?: number
  pricing?: PricingConfig
}

type AuthStatus = 'loading' | 'anon' | 'authed'

type AuthState = {
  status: AuthStatus
  user: AccountUser | null
  config: PublicConfig | null
  /** 登录过期等需要展示的提示 */
  notice: 'expired' | null
}

export const useAuth = create<AuthState>(() => ({
  status: 'loading',
  user: null,
  config: null,
  notice: null,
}))

const setAuthed = (user: AccountUser) => {
  useAuth.setState({ status: 'authed', user, notice: null })
}

const setAnon = (notice: 'expired' | null = null) => {
  useAuth.setState({ status: 'anon', user: null, notice })
}

let initialized = false

/** 登录态失效（任意后端接口返回 401）时回到登录页并清空本地会话缓存。 */
const handleUnauthorized = () => {
  if (useAuth.getState().status === 'authed') {
    resetChatStore()
    setAnon('expired')
  }
}

export const canChat = (user: AccountUser | null, config: PublicConfig | null): boolean =>
  Boolean(user && (user.hasApiKey || user.usingServerApiKey || config?.hasDefaultApiKey))

/** 应用启动时调用：读取公开配置与当前登录态。 */
export const initAuth = async (): Promise<void> => {
  if (!initialized) {
    initialized = true
    window.addEventListener(UNAUTHORIZED_EVENT, handleUnauthorized)
  }
  try {
    const config = await requestJson<PublicConfig>('/api/auth/config')
    useAuth.setState({ config })
  } catch {
    // 配置读取失败不阻塞登录页
  }
  await refreshSession()
}

export const refreshSession = async (): Promise<boolean> => {
  try {
    const data = await requestJson<{ user: AccountUser }>('/api/auth/me')
    setAuthed(data.user)
    return true
  } catch {
    setAnon()
    return false
  }
}

export const login = async (username: string, password: string): Promise<void> => {
  const data = await requestJson<{ user: AccountUser }>('/api/auth/login', {
    method: 'POST',
    json: { username, password },
  })
  setAuthed(data.user)
}

export const register = async (
  username: string,
  password: string,
  inviteCode: string
): Promise<void> => {
  const data = await requestJson<{ user: AccountUser }>('/api/auth/register', {
    method: 'POST',
    json: { username, password, inviteCode },
  })
  setAuthed(data.user)
}

export const logout = async (): Promise<void> => {
  // 先停掉生成与内存缓存，再清 Cookie，避免旧账号数据残留
  resetChatStore()
  try {
    await requestJson<{ ok: boolean }>('/api/auth/logout', { method: 'POST' })
  } catch {
    // 网络异常时也回到登录页
  }
  setAnon()
}

/** 刷新账号信息（设置页展示绑定状态用）。 */
export const refreshAccount = async (): Promise<AccountUser | null> => {
  try {
    const data = await requestJson<{ account: AccountUser }>('/api/account')
    useAuth.setState({ user: data.account })
    return data.account
  } catch {
    return null
  }
}

/** 绑定（或更新）本账号的 API Key：服务端先校验再加密保存。 */
export const saveApiKey = async (apiKey: string): Promise<AccountUser> => {
  const data = await requestJson<{ account: AccountUser }>('/api/account/api-key', {
    method: 'PUT',
    json: { apiKey },
  })
  useAuth.setState({ user: data.account })
  return data.account
}

export const removeApiKey = async (): Promise<AccountUser> => {
  const data = await requestJson<{ account: AccountUser }>('/api/account/api-key', {
    method: 'DELETE',
  })
  useAuth.setState({ user: data.account })
  return data.account
}

export const changePassword = async (
  currentPassword: string,
  newPassword: string
): Promise<void> => {
  await requestJson<{ ok: boolean }>('/api/auth/password', {
    method: 'POST',
    json: { currentPassword, newPassword },
  })
}
