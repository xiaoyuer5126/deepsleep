import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import express from 'express'
import { createAccountRouter } from './account.js'
import { createAuthRouter } from './auth.js'
import { loadConfig } from './config.js'
import { openDatabase } from './db.js'
import { errorHandler, sameOrigin } from './http.js'
import { createProxyRouter } from './proxy.js'
import { createFileRouter, createImportRouter, createSessionRouter } from './storage.js'

/**
 * 组装 Express 应用。代理、附件、导入三条路由需要各自处理请求体，
 * 因此都注册在全局 JSON 解析之前。
 */
export const createApp = ({ config, store }) => {
  const app = express()
  app.disable('x-powered-by')
  if (config.trustProxy) {
    app.set('trust proxy', 1)
  }

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, time: Date.now() })
  })

  // 可选请求日志：LOG_REQUESTS=1 时打印每个 API 的耗时与大小，便于排查上传/代理慢
  if (config.logRequests) {
    app.use((req, res, next) => {
      const started = Date.now()
      res.on('finish', () => {
        const size = req.headers['content-length']
        // eslint-disable-next-line no-console
        console.log(
          `[req] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - started}ms${
            size ? ` ${size}B` : ''
          }`
        )
      })
      next()
    })
  }

  app.use('/api/ds', sameOrigin, createProxyRouter({ store, config }))
  app.use('/api/files', sameOrigin, createFileRouter({ store, config }))
  app.use('/api/import', sameOrigin, createImportRouter({ store, config }))

  const json = express.json({ limit: config.maxJsonBytes })
  app.use('/api/auth', sameOrigin, json, createAuthRouter({ store, config }))
  app.use('/api/account', sameOrigin, json, createAccountRouter({ store, config }))
  app.use('/api/sessions', sameOrigin, json, createSessionRouter({ store, config }))

  app.use('/api', (req, res) => {
    res.status(404).json({ error: { message: '接口不存在' } })
  })

  const indexFile = path.join(config.webDist, 'index.html')
  if (fs.existsSync(indexFile)) {
    // 带 hash 的资源长缓存，index.html 不缓存，保证升级后立刻生效
    app.use(
      '/static',
      express.static(path.join(config.webDist, 'static'), {
        maxAge: '365d',
        immutable: true,
        fallthrough: true,
      })
    )
    app.use(express.static(config.webDist, { index: false, maxAge: 0, fallthrough: true }))
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        return next()
      }
      res.set('Cache-Control', 'no-cache')
      res.sendFile(indexFile)
    })
  } else {
    app.get('/', (req, res) => {
      res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send('前端尚未构建：请先执行 pnpm build（或在 Docker 中构建镜像）。')
    })
  }

  app.use(errorHandler)
  return app
}

export const startServer = async (overrides = {}) => {
  const config = loadConfig(overrides)
  const store = openDatabase(config.dataDir, {
    sessionDays: config.sessionDays,
    pricing: config.pricing,
  })
  const app = createApp({ config, store })
  const server = http.createServer(app)
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  return { server, config, store, app }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  startServer()
    .then(({ server, config, store }) => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : config.port
      // eslint-disable-next-line no-console
      console.log(`[server] 已启动：http://localhost:${port}`)
      console.log(`[server] 数据目录：${config.dataDir}`)
      console.log(
        `[server] 上游 API：${config.apiBase}${config.defaultApiKey ? '（已配置服务器默认 Key）' : ''}`
      )
      const shutdown = (signal) => {
        // eslint-disable-next-line no-console
        console.log(`[server] 收到 ${signal}，正在关闭…`)
        server.close(() => {
          store.close()
          process.exit(0)
        })
        setTimeout(() => process.exit(1), 8000).unref()
      }
      process.on('SIGINT', () => shutdown('SIGINT'))
      process.on('SIGTERM', () => shutdown('SIGTERM'))
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[server] 启动失败', error)
      process.exit(1)
    })
}
