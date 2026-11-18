/** HTTP 层小工具：Cookie、鉴权中间件、统一错误响应。 */

export class AppError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 包装异步路由，异常交给统一错误处理。 */
export const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}

export const parseCookies = (header) => {
  const cookies = {}
  if (!header) {
    return cookies
  }
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) {
      continue
    }
    const name = part.slice(0, index).trim()
    if (!name) {
      continue
    }
    const value = part.slice(index + 1).trim()
    try {
      cookies[name] = decodeURIComponent(value)
    } catch {
      cookies[name] = value
    }
  }
  return cookies
}

export const SESSION_COOKIE = 'ds_session'

export const setSessionCookie = (res, token, expiresAt, config) => {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (config.cookieSecure) {
    parts.push('Secure')
  }
  res.append('Set-Cookie', parts.join('; '))
}

export const clearSessionCookie = (res, config) => {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (config.cookieSecure) {
    parts.push('Secure')
  }
  res.append('Set-Cookie', parts.join('; '))
}

/** 简单同源校验：浏览器发起的写请求若带 Origin 且与 Host 不一致则拒绝，防 CSRF。 */
export const sameOrigin = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next()
  }
  const origin = req.headers.origin
  if (!origin) {
    return next()
  }
  try {
    const originUrl = new URL(origin)
    const host = req.headers.host ?? ''
    if (originUrl.host !== host) {
      return next(new AppError(403, '跨站请求被拒绝'))
    }
  } catch {
    return next(new AppError(403, '请求来源不合法'))
  }
  return next()
}

/** 从 Cookie 解析登录态；未登录时抛 401。 */
export const createRequireAuth = (store, config) =>
  asyncRoute((req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (!token) {
      throw new AppError(401, '未登录', 'unauthenticated')
    }
    const tokenHash = hashToken(token)
    const session = store.findAuthSession(tokenHash)
    if (!session) {
      throw new AppError(401, '登录已过期，请重新登录', 'unauthenticated')
    }
    const user = store.findUserById(session.user_id)
    if (!user) {
      throw new AppError(401, '账号不存在', 'unauthenticated')
    }
    req.user = user
    req.tokenHash = tokenHash
    req.sessionExpiresAt = session.expires_at
    next()
  })

import { sha256 } from './crypto.js'

export const hashToken = (token) => sha256(token)

/** 统一错误响应：{ error: { message, code } } */
export const errorHandler = (error, req, res, _next) => {
  if (res.headersSent) {
    req.destroy?.()
    return
  }
  const status = error instanceof AppError ? error.status : error.status || 500
  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(`[error] ${req.method} ${req.originalUrl}`, error)
  }
  res.status(status).json({
    error: {
      message: error.message || '服务器内部错误',
      ...(error.code ? { code: error.code } : {}),
    },
  })
}
