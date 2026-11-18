import { Readable } from 'node:stream'
import express from 'express'
import { decryptSecret } from './crypto.js'
import { AppError, asyncRoute, createRequireAuth } from './http.js'

/**
 * DeepSeek API 反向代理：浏览器不再持有 API Key，所有请求由服务端注入账号绑定的 Key。
 * - 流式响应（SSE / 音频）逐块透传，不缓冲
 * - 请求里如果还带着 safety_check（模型内容安全），在这里删掉：自建实例不做安全审核
 * - /v1/tools/tts 等二进制响应原样转发
 */

const FORWARD_HEADERS = new Set([
  'content-type',
  'accept',
  'anthropic-beta',
  'anthropic-version',
  'accept-language',
])

const readBody = (req, limit) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new AppError(413, '请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

export const createProxyRouter = ({ store, config, fetchImpl = fetch }) => {
  const router = express.Router()
  const requireAuth = createRequireAuth(store, config)

  const resolveApiKey = (user) => {
    if (user.api_key_cipher) {
      try {
        const key = decryptSecret(user.api_key_cipher, config.secret)
        if (key) {
          return key
        }
      } catch {
        // 密钥不匹配（例如换了 APP_SECRET）：回落到服务器默认 Key
      }
    }
    if (config.defaultApiKey) {
      return config.defaultApiKey
    }
    throw new AppError(
      401,
      '当前账号还未绑定 API Key，请到「设置 → 数据管理」中填写后再试',
      'no_api_key'
    )
  }

  router.use(requireAuth)

  router.all(
    '/*',
    asyncRoute(async (req, res) => {
      const apiKey = resolveApiKey(req.user)
      const targetUrl = `${config.apiBase}${req.originalUrl.slice('/api/ds'.length)}`
      const headers = {}
      for (const [name, value] of Object.entries(req.headers)) {
        if (FORWARD_HEADERS.has(name.toLowerCase()) && typeof value === 'string') {
          headers[name.toLowerCase()] = value
        }
      }
      headers.authorization = `Bearer ${apiKey}`
      headers['x-api-key'] = apiKey
      // 让上游返回未压缩的响应，便于直接透传
      headers['accept-encoding'] = 'identity'

      const controller = new AbortController()
      res.on('close', () => controller.abort())

      const init = { method: req.method, headers, signal: controller.signal }

      const isJson = (req.headers['content-type'] ?? '').includes('application/json')
      if (req.method === 'GET' || req.method === 'HEAD') {
        // 无请求体
      } else if (isJson) {
        const raw = await readBody(req, config.maxJsonBytes)
        let body = raw
        try {
          const parsed = JSON.parse(raw.toString('utf8'))
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            // 关键：删掉模型内容安全参数
            delete parsed.safety_check
            body = Buffer.from(JSON.stringify(parsed), 'utf8')
          }
        } catch {
          // 不是合法 JSON 就原样转发，让上游返回它自己的报错
        }
        init.body = body
      } else {
        init.body = req
        init.duplex = 'half'
        if (req.headers['content-length']) {
          headers['content-length'] = req.headers['content-length']
        }
      }

      let upstream
      try {
        upstream = await fetchImpl(targetUrl, init)
      } catch (error) {
        if (controller.signal.aborted) {
          return
        }
        throw new AppError(
          502,
          `无法连接 DeepSeek API：${error instanceof Error ? error.message : String(error)}`
        )
      }

      res.status(upstream.status)
      const contentType = upstream.headers.get('content-type')
      if (contentType) {
        res.set('Content-Type', contentType)
      }
      res.set('Cache-Control', 'no-store')
      res.set('X-Accel-Buffering', 'no')
      res.flushHeaders()

      if (!upstream.body) {
        const text = await upstream.text().catch(() => '')
        res.end(text)
        return
      }
      const nodeStream = Readable.fromWeb(upstream.body)
      nodeStream.on('error', () => res.destroy())
      res.on('close', () => nodeStream.destroy())
      nodeStream.pipe(res)
    })
  )

  return router
}
