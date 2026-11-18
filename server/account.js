import express from 'express'
import { decryptSecret, encryptSecret, maskApiKey } from './crypto.js'
import { AppError, asyncRoute, createRequireAuth } from './http.js'

/** 用 /models 校验 Key 是否可用（不产生费用）。 */
const verifyUpstreamKey = async (config, apiKey) => {
  let response
  try {
    response = await fetch(`${config.apiBase}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    throw new AppError(502, `无法连接 DeepSeek API 校验 Key：${error.message}`)
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError(400, 'API Key 无效，请检查后重试')
  }
  if (!response.ok) {
    throw new AppError(502, `校验 API Key 失败（HTTP ${response.status}）`)
  }
}

export const createAccountRouter = ({ store, config }) => {
  const router = express.Router()
  const requireAuth = createRequireAuth(store, config)

  const info = (user) => {
    const ownKey = user.api_key_cipher ? decryptSecretSafe(user.api_key_cipher, config) : null
    return {
      id: user.id,
      username: user.username,
      createdAt: user.created_at,
      hasApiKey: Boolean(user.api_key_cipher),
      apiKeyMasked: ownKey ? maskApiKey(ownKey) : '',
      usingServerApiKey: !user.api_key_cipher && Boolean(config.defaultApiKey),
      serverApiKeyAvailable: Boolean(config.defaultApiKey),
      // 账号下全部会话的用量合计，前端按当前单价估算累计花费
      usage: store.getUserUsage(user.id),
    }
  }

  router.get('/', requireAuth, (req, res) => {
    res.json({ account: info(req.user) })
  })

  /** 绑定/更新本账号的 API Key；保存前先在服务端校验，浏览器永远拿不到明文。 */
  router.put(
    '/api-key',
    requireAuth,
    asyncRoute(async (req, res) => {
      const apiKey = String(req.body?.apiKey ?? '').trim()
      if (!apiKey) {
        throw new AppError(400, '请输入 API Key')
      }
      if (apiKey.length < 10 || apiKey.length > 500 || /\s/.test(apiKey)) {
        throw new AppError(400, 'API Key 格式不正确')
      }
      await verifyUpstreamKey(config, apiKey)
      store.setUserApiKey(req.user.id, encryptSecret(apiKey, config.secret))
      const user = store.findUserById(req.user.id)
      res.json({ account: info(user) })
    })
  )

  router.delete('/api-key', requireAuth, (req, res) => {
    store.setUserApiKey(req.user.id, null)
    const user = store.findUserById(req.user.id)
    res.json({ account: info(user) })
  })

  return router
}

const decryptSecretSafe = (cipher, config) => {
  try {
    return decryptSecret(cipher, config.secret)
  } catch {
    return null
  }
}
