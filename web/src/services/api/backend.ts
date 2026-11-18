/**
 * 自建后端（账号、会话、附件、导入导出）的请求封装。
 * 与 DeepSeek API 代理（/api/ds）分开：这里的 401 表示登录态失效，需要回到登录页。
 */

export const UNAUTHORIZED_EVENT = 'ds:unauthorized'

export class BackendError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = 'BackendError'
    this.status = status
    this.code = code
  }
}

type BackendOptions = Omit<RequestInit, 'body'> & {
  /** 自动序列化为 JSON 并带上 Content-Type */
  json?: unknown
  body?: BodyInit | null
}

export const requestBackend = async (
  path: string,
  { json, body, ...init }: BackendOptions = {}
): Promise<Response> => {
  const headers = new Headers(init.headers)
  if (json !== undefined) {
    headers.set('Content-Type', 'application/json')
    body = JSON.stringify(json)
  }
  const response = await fetch(path, {
    ...init,
    headers,
    body,
    credentials: 'same-origin',
    cache: 'no-store',
  })
  if (response.status === 401) {
    // 登录过期：通知应用回到登录页，仅当请求不是登录/注册接口时
    if (!path.startsWith('/api/auth/login') && !path.startsWith('/api/auth/register')) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
    }
  }
  if (!response.ok) {
    let message = response.statusText || `请求失败（HTTP ${response.status}）`
    let code: string | undefined
    try {
      const data: unknown = await response.json()
      if (
        typeof data === 'object' &&
        data !== null &&
        'error' in data &&
        typeof (data as { error?: { message?: unknown } }).error?.message === 'string'
      ) {
        const error = (data as { error: { message: string; code?: string } }).error
        message = error.message
        code = error.code
      }
    } catch {
      // 非 JSON 响应体，保留状态文案
    }
    throw new BackendError(response.status, message, code)
  }
  return response
}

export const requestJson = async <T>(
  path: string,
  options: BackendOptions = {}
): Promise<T> => (await requestBackend(path, options)).json() as Promise<T>
