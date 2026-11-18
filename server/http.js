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

/**
 * Secure 只在「本次请求确实是 HTTPS」时加：公网走 Cloudflare 隧道（带 X-Forwarded-Proto、
 * TRUST_PROXY=true）会加 Secure；本机 http://localhost 调试时不加，否则浏览器不会保存/发送 Cookie。
 */
const shouldSecureCookie = (config, requestSecure) => config.cookieSecure && requestSecure

export const setSessionCookie = (res, token, expiresAt, config, requestSecure = false) => {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ]
  if (shouldSecureCookie(config, requestSecure)) {
    parts.push('Secure')
  }
  res.append('Set-Cookie', parts.join('; '))
}

export const clearSessionCookie = (res, config, requestSecure = false) => {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (shouldSecureCookie(config, requestSecure)) {
    parts.push('Secure')
  }
  res.append('Set-Cookie', parts.join('; '))
}

/**
 * 同源校验：浏览器发起的写请求若带 Origin，则要求 Origin 的 hostname 属于本站，
 * 否则拒绝（防 CSRF）。只比较 hostname、忽略端口，并兼容反向代理：
 * Host 头、X-Forwarded-Host、以及 trust proxy 下的 req.hostname 都算「本站」。
 */
export const sameOrigin = (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next()
  }
  const origin = req.headers.origin
  if (!origin) {
    return next()
  }
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch {
    return next(new AppError(403, '请求来源不合法'))
  }

  const allowed = new Set()
  const addHost = (value) => {
    if (!value) {
      return
    }
    for (const part of String(value).split(',')) {
      const host = part.trim().toLowerCase()
      if (!host) {
        continue
      }
      // 去掉端口，只比较 hostname
      allowed.add(host.replace(/:\d+$/, ''))
    }
  }
  addHost(req.headers.host)
  addHost(req.headers['x-forwarded-host'])
  addHost(req.hostname)

  if (allowed.has(originUrl.hostname.toLowerCase())) {
    return next()
  }

  // 反代没保留 Host 时，日志里留一行方便定位（浏览器控制台只看得到 403）
  // eslint-disable-next-line no-console
  console.warn(
    `[same-origin] 拒绝跨站请求 method=${req.method} origin=${origin} host=${req.headers.host} x-forwarded-host=${req.headers['x-forwarded-host'] ?? ''}`
  )
  return next(new AppError(403, '跨站请求被拒绝'))
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
