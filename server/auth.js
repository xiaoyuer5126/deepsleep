import express from 'express'
import { publicConfig } from './config.js'
import { hashPassword, randomToken, verifyPassword } from './crypto.js'
import {
  AppError,
  asyncRoute,
  clearSessionCookie,
  createRequireAuth,
  hashToken,
  setSessionCookie,
} from './http.js'

const USERNAME_RE = /^[a-zA-Z0-9_.-]{2,32}$/
const PASSWORD_MIN = 8
const PASSWORD_MAX = 200

/** 登录失败限流：同一 IP + 用户名 10 分钟内最多 10 次失败。 */
const createLoginLimiter = () => {
  const attempts = new Map()
  const windowMs = 10 * 60 * 1000
  const max = 10
  const key = (req, username) => `${req.ip ?? ''}|${String(username).toLowerCase()}`

  const check = (req, username) => {
    const entry = attempts.get(key(req, username))
    if (!entry) {
      return
    }
    if (entry.resetAt < Date.now()) {
      attempts.delete(key(req, username))
      return
    }
    if (entry.count >= max) {
      throw new AppError(429, '尝试次数过多，请稍后再试')
    }
  }

  const fail = (req, username) => {
    const entry = attempts.get(key(req, username))
    if (!entry || entry.resetAt < Date.now()) {
      attempts.set(key(req, username), { count: 1, resetAt: Date.now() + windowMs })
    } else {
      entry.count += 1
    }
  }

  const reset = (req, username) => attempts.delete(key(req, username))

  // 定期清理，避免长期运行内存增长
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [entryKey, entry] of attempts) {
      if (entry.resetAt < now) {
        attempts.delete(entryKey)
      }
    }
  }, windowMs)
  timer.unref()

  return { check, fail, reset }
}

export const createAuthRouter = ({ store, config }) => {
  const router = express.Router()
  const requireAuth = createRequireAuth(store, config)
  const limiter = createLoginLimiter()

  const userInfo = (user) => ({
    id: user.id,
    username: user.username,
    createdAt: user.created_at,
    hasApiKey: Boolean(user.api_key_cipher),
    apiKeyMasked: user.api_key_cipher ? '****' : '',
    usingServerApiKey: !user.api_key_cipher && Boolean(config.defaultApiKey),
  })

  const startSession = (req, res, user) => {
    const token = randomToken(32)
    const tokenHash = hashToken(token)
    const { expiresAt } = store.createAuthSession({
      tokenHash,
      userId: user.id,
      userAgent: req.headers['user-agent'] ?? null,
    })
    store.touchLogin(user.id)
    setSessionCookie(res, token, expiresAt, config, req.secure)
    return expiresAt
  }

  /** 公开配置：注册开关等，登录页用 */
  router.get('/config', (req, res) => {
    res.json(publicConfig(config))
  })

  router.post(
    '/register',
    asyncRoute(async (req, res) => {
      if (!config.allowRegistration) {
        throw new AppError(403, '本站已关闭注册')
      }
      const username = String(req.body?.username ?? '').trim()
      const password = String(req.body?.password ?? '')
      const inviteCode = String(req.body?.inviteCode ?? '').trim()
      if (!USERNAME_RE.test(username)) {
        throw new AppError(400, '用户名需为 2-32 位字母、数字、下划线、点或短横线')
      }
      if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        throw new AppError(400, `密码长度需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符`)
      }
      if (config.registerInviteCode && inviteCode !== config.registerInviteCode) {
        throw new AppError(403, '邀请码不正确')
      }
      if (store.findUserByUsername(username)) {
        throw new AppError(409, '该用户名已被注册')
      }
      const { hash, salt } = await hashPassword(password)
      const user = store.createUser({ username, passwordHash: hash, passwordSalt: salt })
      startSession(req, res, user)
      res.status(201).json({ user: userInfo(user) })
    })
  )

  router.post(
    '/login',
    asyncRoute(async (req, res) => {
      const username = String(req.body?.username ?? '').trim()
      const password = String(req.body?.password ?? '')
      if (!username || !password) {
        throw new AppError(400, '请输入用户名和密码')
      }
      limiter.check(req, username)
      const user = store.findUserByUsername(username)
      if (!user) {
        limiter.fail(req, username)
        throw new AppError(401, '用户名或密码错误')
      }
      const ok = await verifyPassword(password, user.password_salt, user.password_hash)
      if (!ok) {
        limiter.fail(req, username)
        throw new AppError(401, '用户名或密码错误')
      }
      limiter.reset(req, username)
      startSession(req, res, user)
      res.json({ user: userInfo(store.findUserById(user.id)) })
    })
  )

  router.post('/logout', (req, res) => {
    const token = req.headers.cookie
      ? (req.headers.cookie.split(';').find((part) => part.trim().startsWith('ds_session=')) ?? '')
          .split('=')
          .slice(1)
          .join('=')
      : ''
    if (token) {
      try {
        store.deleteAuthSession(hashToken(decodeURIComponent(token.trim())))
      } catch {
        // Cookie 已损坏时直接清理客户端即可
      }
    }
    clearSessionCookie(res, config, req.secure)
    res.json({ ok: true })
  })

  router.get(
    '/me',
    requireAuth,
    asyncRoute(async (req, res) => {
      res.json({ user: userInfo(req.user) })
    })
  )

  router.post(
    '/password',
    requireAuth,
    asyncRoute(async (req, res) => {
      const currentPassword = String(req.body?.currentPassword ?? '')
      const newPassword = String(req.body?.newPassword ?? '')
      if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
        throw new AppError(400, `密码长度需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符`)
      }
      const ok = await verifyPassword(
        currentPassword,
        req.user.password_salt,
        req.user.password_hash
      )
      if (!ok) {
        throw new AppError(400, '当前密码错误')
      }
      const { hash, salt } = await hashPassword(newPassword)
      store.updateUserPassword(req.user.id, hash, salt)
      // 其他设备上的登录态失效，当前设备保持登录
      store.deleteOtherAuthSessions(req.user.id, req.tokenHash)
      res.json({ ok: true })
    })
  )

  return router
}
