import express from 'express'
import { sanitizeSession } from './db.js'
import { AppError, asyncRoute, createRequireAuth } from './http.js'

const FILE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

const assertFileId = (id) => {
  if (!FILE_ID_RE.test(String(id ?? ''))) {
    throw new AppError(400, '附件 id 不合法')
  }
  return String(id)
}

/** 会话元信息：列表接口只返回摘要，打开会话时才取完整数据。 */
const summaryOf = (session) => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})

export const createSessionRouter = ({ store, config }) => {
  const router = express.Router()
  const requireAuth = createRequireAuth(store, config)

  router.get('/', requireAuth, (req, res) => {
    res.json({ sessions: store.listSessions(req.user.id) })
  })

  router.get('/:id', requireAuth, (req, res) => {
    const data = store.getSession(req.user.id, assertFileId(req.params.id))
    if (!data) {
      throw new AppError(404, '会话不存在')
    }
    res.json({ session: JSON.parse(data) })
  })

  /** 全量保存一条会话（流式生成期间高频调用），附带的原件单独上传。 */
  router.put('/:id', requireAuth, (req, res) => {
    const id = assertFileId(req.params.id)
    const session = sanitizeSession(req.body?.session, id)
    store.saveSession(req.user.id, session)
    res.json({ session: summaryOf(session) })
  })

  router.patch('/:id', requireAuth, (req, res) => {
    const id = assertFileId(req.params.id)
    const title = String(req.body?.title ?? '')
    store.renameSession(req.user.id, id, title)
    res.json({ ok: true })
  })

  router.delete('/:id', requireAuth, (req, res) => {
    store.deleteSession(req.user.id, assertFileId(req.params.id))
    res.json({ ok: true })
  })

  return router
}

/** 附件原件：客户端生成的 id 作为主键，BLOB 存放，多端登录后可再次下载展示。 */
export const createFileRouter = ({ store, config }) => {
  const router = express.Router()
  const requireAuth = createRequireAuth(store, config)
  const rawBody = express.raw({ type: () => true, limit: config.maxUploadBytes })

  router.put(
    '/:id',
    requireAuth,
    rawBody,
    asyncRoute(async (req, res) => {
      const id = assertFileId(req.params.id)
      const data = req.body
      if (!Buffer.isBuffer(data) || data.byteLength === 0) {
        throw new AppError(400, '文件内容为空')
      }
      const mime = String(req.query.mime ?? req.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
      store.putFile(req.user.id, id, mime, data)
      res.json({ ok: true, id, size: data.byteLength, mime })
    })
  )

  router.get('/:id', requireAuth, (req, res) => {
    const row = store.getFile(req.user.id, assertFileId(req.params.id))
    if (!row) {
      throw new AppError(404, '附件不存在')
    }
    res.set('Content-Type', row.mime || 'application/octet-stream')
    res.set('Cache-Control', 'private, max-age=31536000, immutable')
    res.send(Buffer.from(row.data))
  })

  return router
}

/**
 * 历史导入：先写暂存区，全部校验通过后一次事务替换该账号的全部会话与附件；
 * 导入失败只清空暂存，原数据不受影响。
 */
export const createImportRouter = ({ store, config }) => {
  const router = express.Router()
  const requireAuth = createRequireAuth(store, config)
  const jsonBody = express.json({ limit: config.maxJsonBytes })
  const rawBody = express.raw({ type: () => true, limit: config.maxUploadBytes })

  router.post('/reset', requireAuth, (req, res) => {
    store.resetStaging(req.user.id)
    res.json({ ok: true })
  })

  router.put(
    '/sessions/:id',
    requireAuth,
    jsonBody,
    asyncRoute(async (req, res) => {
      const session = sanitizeSession(req.body?.session, req.params.id)
      store.putStagingSession(req.user.id, session)
      res.json({ ok: true })
    })
  )

  router.put(
    '/files/:id',
    requireAuth,
    rawBody,
    asyncRoute(async (req, res) => {
      const id = assertFileId(req.params.id)
      const data = req.body
      if (!Buffer.isBuffer(data) || data.byteLength === 0) {
        throw new AppError(400, '文件内容为空')
      }
      const mime = String(req.query.mime ?? req.headers['content-type'] ?? '')
        .split(';')[0]
        .trim()
      store.putFile(req.user.id, id, mime, data, true)
      res.json({ ok: true })
    })
  )

  router.post('/file-types', requireAuth, jsonBody, (req, res) => {
    const types = req.body?.types
    if (!types || typeof types !== 'object' || Array.isArray(types)) {
      throw new AppError(400, 'types 必须是对象')
    }
    const clean = {}
    for (const [id, mime] of Object.entries(types)) {
      if (FILE_ID_RE.test(id) && typeof mime === 'string') {
        clean[id] = mime.slice(0, 200)
      }
    }
    store.updateStagingFileTypes(req.user.id, clean)
    res.json({ ok: true })
  })

  router.post('/commit', requireAuth, (req, res) => {
    const summaries = store.commitStaging(req.user.id)
    res.json({ sessions: summaries })
  })

  return router
}
