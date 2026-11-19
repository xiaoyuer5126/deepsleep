import express from 'express'
import { AppError, asyncRoute, createRequireAuth } from './http.js'

/**
 * DeepSeek 官网分享链接导入：浏览器跨域拿不到分享内容和图片，由服务端代为请求。
 * - GET /api/share/content?url=<分享链接或 id>：返回官网分享接口的 biz_data（标题、消息树）
 * - GET /api/share/file?path=<signed_path>：代下分享里的图片预览图
 * 两个接口都只请求配置里固定的官网域名，不接受任意地址。
 */

const SHARE_ID_RE = /^[A-Za-z0-9_-]{6,64}$/
const FETCH_TIMEOUT_MS = 20_000
/** 分享内容 JSON 与单张预览图的上限 */
const MAX_CONTENT_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024

/** 接受完整分享链接（chat.deepseek.com/share/<id>）或单独的 id。 */
export const parseShareId = (input) => {
  const raw = String(input ?? '').trim()
  if (SHARE_ID_RE.test(raw)) {
    return raw
  }
  let url
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return null
  }
  if (!/(^|\.)deepseek\.com$/i.test(url.hostname)) {
    return null
  }
  const match = /\/share\/([^/?#]+)/.exec(url.pathname)
  const id = match?.[1] ?? url.searchParams.get('share_id')
  return id && SHARE_ID_RE.test(id) ? id : null
}

/** signed_path 形如 /file?file_id=<uuid>&state=<签名>；只取这两个参数重新拼。 */
export const parseSignedPath = (input) => {
  const raw = String(input ?? '')
  if (!raw.startsWith('/file?')) {
    return null
  }
  const params = new URLSearchParams(raw.slice('/file?'.length))
  const fileId = params.get('file_id') ?? ''
  const state = params.get('state') ?? ''
  if (!/^[A-Za-z0-9-]{1,64}$/.test(fileId) || !/^[A-Za-z0-9_\-=.~]{1,2048}$/.test(state)) {
    return null
  }
  return { fileId, state }
}

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Referer: 'https://chat.deepseek.com/',
  Origin: 'https://chat.deepseek.com',
}

const readLimited = async (response, limit) => {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > limit) {
    throw new AppError(502, '分享内容过大')
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.byteLength > limit) {
    throw new AppError(502, '分享内容过大')
  }
  return buffer
}

const fetchWithTimeout = async (fetchImpl, url, init) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } catch {
    throw new AppError(502, controller.signal.aborted ? '请求 DeepSeek 超时' : '无法连接 DeepSeek')
  } finally {
    clearTimeout(timer)
  }
}

export const createShareRouter = ({ store, config, fetchImpl = fetch }) => {
  const router = express.Router()
  const requireAuth = createRequireAuth(store, config)

  router.get(
    '/content',
    requireAuth,
    asyncRoute(async (req, res) => {
      const shareId = parseShareId(req.query.url)
      if (!shareId) {
        throw new AppError(400, '不是有效的 DeepSeek 分享链接')
      }
      const target = `${config.shareApiBase}/api/v0/share/content?share_id=${encodeURIComponent(shareId)}`
      const upstream = await fetchWithTimeout(fetchImpl, target, {
        headers: { ...BROWSER_HEADERS, Accept: 'application/json' },
      })
      if (!upstream.ok) {
        throw new AppError(502, `DeepSeek 返回 ${upstream.status}`)
      }
      let body
      try {
        body = JSON.parse((await readLimited(upstream, MAX_CONTENT_BYTES)).toString('utf8'))
      } catch (error) {
        throw error instanceof AppError ? error : new AppError(502, 'DeepSeek 返回的不是 JSON')
      }
      const data = body?.data
      if (data?.biz_code !== 0 || !data?.biz_data || !Array.isArray(data.biz_data.messages)) {
        // 链接失效或被删除时 biz_code 非 0，biz_msg 如 "share does not exist"
        throw new AppError(404, '分享不存在或已被删除', 'share_not_found')
      }
      res.json({ shareId, share: data.biz_data })
    })
  )

  router.get(
    '/file',
    requireAuth,
    asyncRoute(async (req, res) => {
      const signed = parseSignedPath(req.query.path)
      if (!signed) {
        throw new AppError(400, '图片地址不合法')
      }
      // ty=p 是预览图（原图 ty=r 不对外开放），fmt=jpeg 固定格式便于识别
      const query = new URLSearchParams({
        file_id: signed.fileId,
        state: signed.state,
        ty: 'p',
        fmt: 'jpeg',
      })
      const upstream = await fetchWithTimeout(
        fetchImpl,
        `${config.shareFilesBase}/api/file?${query}`,
        { headers: { ...BROWSER_HEADERS, Accept: 'image/*' } }
      )
      const mime = (upstream.headers.get('content-type') ?? '').split(';')[0].trim()
      if (!upstream.ok || !mime.startsWith('image/')) {
        throw new AppError(502, '图片下载失败')
      }
      const data = await readLimited(upstream, MAX_IMAGE_BYTES)
      res.set('Content-Type', mime)
      res.set('Cache-Control', 'no-store')
      res.send(data)
    })
  )

  return router
}
