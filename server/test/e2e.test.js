import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { loadConfig } from '../config.js'
import { openDatabase } from '../db.js'
import { createApp } from '../index.js'
import { startMockUpstream } from './mock-upstream.js'

const cleanups = []
after(async () => {
  for (const cleanup of cleanups.toReversed()) {
    await cleanup()
  }
})

/** 启动一套独立的后端实例（独立数据目录 + 独立 mock 上游）。 */
const startApp = async (options = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsw-test-'))
  const upstream = await startMockUpstream()
  const config = loadConfig({
    dataDir,
    secret: 'test-secret',
    apiBase: upstream.url,
    port: 0,
    host: '127.0.0.1',
    defaultApiKey: options.defaultApiKey ?? '',
    allowRegistration: options.allowRegistration ?? true,
    registerInviteCode: options.inviteCode ?? '',
    webDist: path.join(dataDir, 'no-web'),
    sessionDays: 30,
  })
  const store = openDatabase(dataDir, { sessionDays: config.sessionDays })
  const app = createApp({ config, store })
  const server = http.createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const close = async () => {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    store.close()
    await upstream.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  cleanups.push(close)
  return { base, upstream, config, store, close }
}

/** 带 Cookie 的简易客户端。 */
const makeClient = (base) => {
  let cookie = ''
  const call = async (method, apiPath, { body, headers = {}, cookieValue } = {}) => {
    const isBinary =
      body instanceof Uint8Array ||
      body instanceof ArrayBuffer ||
      body instanceof Blob ||
      body instanceof FormData
    const isJsonBody = body !== undefined && !isBinary && typeof body !== 'string'
    const response = await fetch(`${base}${apiPath}`, {
      method,
      headers: {
        ...(cookieValue !== undefined ? { cookie: cookieValue } : cookie ? { cookie } : {}),
        ...(isJsonBody ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isJsonBody ? JSON.stringify(body) : body,
    })
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const pair = raw.split(';')[0]
      if (pair.startsWith('ds_session=')) {
        cookie = pair
      }
    }
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, json, text, headers: response.headers }
  }
  return { call, get cookie() {
    return cookie
  } }
}

const sampleSession = (id, title = '示例会话') => ({
  id,
  title,
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  rootMessageId: 'm1',
  messages: [
    {
      id: 'm1',
      role: 'user',
      content: '你好',
      files: [{ id: 'local-file-1', serverId: 'file-api-test-1', name: 'a.png', size: 3, isImage: true, mimeType: 'image/png' }],
      createdAt: 1700000000000,
    },
    {
      id: 'm2',
      role: 'assistant',
      parentId: 'm1',
      createdAt: 1700000001000,
      model: 'deepseek-flash',
      prefix: true,
      status: 'done',
      blocks: [{ type: 'text', text: '你好！' }],
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 50,
        output_tokens: 20,
        server_tool_use: { web_search_requests: 2, tool_search: 1, tool_fetch: 0, tool_image_search: 0 },
      },
    },
  ],
})

const register = async (client, username = 'alice', password = 'password123', extra = {}) =>
  client.call('POST', '/api/auth/register', { body: { username, password, ...extra } })

test('健康检查与公开配置', async () => {
  const { base } = await startApp()
  const client = makeClient(base)
  const health = await client.call('GET', '/api/health')
  assert.equal(health.status, 200)
  assert.equal(health.json.ok, true)
  const config = await client.call('GET', '/api/auth/config')
  assert.equal(config.status, 200)
  assert.equal(config.json.allowRegistration, true)
  assert.equal(config.json.requireInviteCode, false)
})

test('注册、登录态、密码修改与退出', async () => {
  const { base } = await startApp()
  const client = makeClient(base)

  const created = await register(client)
  assert.equal(created.status, 201)
  assert.equal(created.json.user.username, 'alice')
  assert.equal(created.json.user.hasApiKey, false)

  const me = await client.call('GET', '/api/auth/me')
  assert.equal(me.status, 200)
  assert.equal(me.json.user.username, 'alice')

  const duplicate = await register(client, 'ALICE')
  assert.equal(duplicate.status, 409)

  const anon = makeClient(base)
  const badLogin = await anon.call('POST', '/api/auth/login', {
    body: { username: 'alice', password: 'wrong-password' },
  })
  assert.equal(badLogin.status, 401)
  assert.equal((await anon.call('GET', '/api/auth/me')).status, 401)

  const login = await anon.call('POST', '/api/auth/login', {
    body: { username: 'alice', password: 'password123' },
  })
  assert.equal(login.status, 200)
  assert.equal((await anon.call('GET', '/api/auth/me')).status, 200)

  // 修改密码后其他设备登录态失效
  const changed = await anon.call('POST', '/api/auth/password', {
    body: { currentPassword: 'password123', newPassword: 'newpassword456' },
  })
  assert.equal(changed.status, 200)
  assert.equal((await client.call('GET', '/api/auth/me')).status, 401)
  assert.equal((await anon.call('GET', '/api/auth/me')).status, 200)

  const logout = await anon.call('POST', '/api/auth/logout')
  assert.equal(logout.status, 200)
  assert.equal((await anon.call('GET', '/api/auth/me')).status, 401)
})

test('用户名与密码校验、邀请码、关闭注册', async () => {
  const { base } = await startApp({ inviteCode: 'let-me-in' })
  const client = makeClient(base)

  const badName = await register(client, 'a')
  assert.equal(badName.status, 400)

  const shortPassword = await register(client, 'bob', '123')
  assert.equal(shortPassword.status, 400)

  const wrongInvite = await register(client, 'bob', 'password123', { inviteCode: 'nope' })
  assert.equal(wrongInvite.status, 403)

  const ok = await register(client, 'bob', 'password123', { inviteCode: 'let-me-in' })
  assert.equal(ok.status, 201)

  const closed = await startApp({ allowRegistration: false })
  const closedClient = makeClient(closed.base)
  const rejected = await register(closedClient, 'carol')
  assert.equal(rejected.status, 403)
})

test('会话增删改查与跨账号隔离', async () => {
  const { base } = await startApp()
  const alice = makeClient(base)
  await register(alice)
  const bob = makeClient(base)
  await register(bob, 'bob')

  const unauthorized = await fetch(`${base}/api/sessions`)
  assert.equal(unauthorized.status, 401)

  const session = sampleSession('sess-1')
  const put = await alice.call('PUT', '/api/sessions/sess-1', { body: { session } })
  assert.equal(put.status, 200)

  const list = await alice.call('GET', '/api/sessions')
  assert.equal(list.status, 200)
  assert.equal(list.json.sessions.length, 1)
  assert.equal(list.json.sessions[0].title, '示例会话')
  // 侧边栏费用所需的用量汇总：按计费口径统计（web_search_requests 不算计费次数）
  assert.equal(list.json.sessions[0].usage.offPeak.inputMiss, 100)
  assert.equal(list.json.sessions[0].usage.offPeak.cacheHit, 50)
  assert.equal(list.json.sessions[0].usage.offPeak.output, 20)
  assert.equal(list.json.sessions[0].usage.offPeak.searches, 1)
  assert.equal(list.json.sessions[0].pinned, false)

  const detail = await alice.call('GET', '/api/sessions/sess-1')
  assert.equal(detail.status, 200)
  assert.deepEqual(detail.json.session, session)

  const renamed = await alice.call('PATCH', '/api/sessions/sess-1', { body: { title: '新标题' } })
  assert.equal(renamed.status, 200)
  assert.equal((await alice.call('GET', '/api/sessions/sess-1')).json.session.title, '新标题')

  // 其他账号看不到也改不了
  assert.equal((await bob.call('GET', '/api/sessions/sess-1')).status, 404)
  assert.equal((await bob.call('GET', '/api/sessions')).json.sessions.length, 0)
  assert.equal((await bob.call('DELETE', '/api/sessions/sess-1')).status, 200)
  assert.equal((await alice.call('GET', '/api/sessions/sess-1')).status, 200)

  const removed = await alice.call('DELETE', '/api/sessions/sess-1')
  assert.equal(removed.status, 200)
  assert.equal((await alice.call('GET', '/api/sessions/sess-1')).status, 404)
})

test('附件原件的上传、下载与回收', async () => {
  const { base } = await startApp()
  const client = makeClient(base)
  await register(client)

  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const uploaded = await client.call('PUT', '/api/files/local-file-1?mime=image/png', {
    body: bytes,
    headers: { 'content-type': 'application/octet-stream' },
  })
  assert.equal(uploaded.status, 200)

  const downloaded = await fetch(`${base}/api/files/local-file-1`, { headers: { cookie: client.cookie } })
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('content-type'), 'image/png')
  assert.deepEqual([...new Uint8Array(await downloaded.arrayBuffer())], [1, 2, 3, 4, 5])

  // 会话删除后，未被引用的原件会被回收
  await client.call('PUT', '/api/sessions/sess-files', {
    body: { session: sampleSession('sess-files') },
  })
  assert.equal(
    (await fetch(`${base}/api/files/local-file-1`, { headers: { cookie: client.cookie } })).status,
    200
  )
  await client.call('DELETE', '/api/sessions/sess-files')
  assert.equal(
    (await fetch(`${base}/api/files/local-file-1`, { headers: { cookie: client.cookie } })).status,
    404
  )
})

test('历史导入：暂存、原子替换、清空', async () => {
  const { base } = await startApp()
  const client = makeClient(base)
  await register(client)

  assert.equal((await client.call('POST', '/api/import/reset')).status, 200)
  const stagedA = sampleSession('import-a', '导入A')
  const stagedB = sampleSession('import-b', '导入B')
  assert.equal(
    (await client.call('PUT', '/api/import/sessions/import-a', { body: { session: stagedA } })).status,
    200
  )
  assert.equal(
    (await client.call('PUT', '/api/import/sessions/import-b', { body: { session: stagedB } })).status,
    200
  )
  const fileBytes = new Uint8Array([9, 9, 9])
  assert.equal(
    (
      await client.call('PUT', '/api/import/files/local-file-1?mime=image/png', {
        body: fileBytes,
        headers: { 'content-type': 'image/png' },
      })
    ).status,
    200
  )
  assert.equal(
    (
      await client.call('POST', '/api/import/file-types', {
        body: { types: { 'local-file-1': 'image/png' } },
      })
    ).status,
    200
  )

  const committed = await client.call('POST', '/api/import/commit')
  assert.equal(committed.status, 200)
  assert.equal(committed.json.sessions.length, 2)
  const list = await client.call('GET', '/api/sessions')
  assert.deepEqual(
    list.json.sessions.map((item) => item.id).sort(),
    ['import-a', 'import-b']
  )
  const importedFile = await fetch(`${base}/api/files/local-file-1`, {
    headers: { cookie: client.cookie },
  })
  assert.equal(importedFile.status, 200)

  // 空导入 = 清空全部
  assert.equal((await client.call('POST', '/api/import/reset')).status, 200)
  const cleared = await client.call('POST', '/api/import/commit')
  assert.equal(cleared.json.sessions.length, 0)
  assert.equal((await client.call('GET', '/api/sessions')).json.sessions.length, 0)
})

test('API Key 绑定：校验、加密保存、删除', async () => {
  const { base, store } = await startApp()
  const client = makeClient(base)
  await register(client)

  const invalid = await client.call('PUT', '/api/account/api-key', {
    body: { apiKey: 'sk-invalid' },
  })
  assert.equal(invalid.status, 400)

  const saved = await client.call('PUT', '/api/account/api-key', {
    body: { apiKey: 'sk-valid-key-123456' },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.account.hasApiKey, true)
  assert.match(saved.json.account.apiKeyMasked, /\*\*\*\*/)

  const user = store.findUserByUsername('alice')
  assert.ok(user.api_key_cipher)
  assert.ok(!user.api_key_cipher.includes('sk-valid-key-123456'), 'API Key 必须加密存储')

  const removed = await client.call('DELETE', '/api/account/api-key')
  assert.equal(removed.status, 200)
  assert.equal(removed.json.account.hasApiKey, false)
})

test('代理：流式透传、注入账号 Key、删除 safety_check', async () => {
  const { base, upstream } = await startApp()
  const client = makeClient(base)
  await register(client)
  await client.call('PUT', '/api/account/api-key', { body: { apiKey: 'sk-valid-key-123456' } })

  const models = await client.call('GET', '/api/ds/models')
  assert.equal(models.status, 200)
  assert.equal(models.json.data[0].id, 'deepseek-flash')

  const streamResponse = await fetch(`${base}/api/ds/anthropic/v1/messages`, {
    method: 'POST',
    headers: { cookie: client.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: '你好' }],
      safety_check: { level: 'high' },
      tools: [{ type: 'deepseek_web_search', name: 'deepseek_web_search' }],
      stream: true,
    }),
  })
  assert.equal(streamResponse.status, 200)
  assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/)
  const streamText = await streamResponse.text()
  assert.match(streamText, /message_start/)
  assert.match(streamText, /message_stop/)

  const sent = upstream.messageBodies.at(-1)
  assert.equal(sent.safety_check, undefined, '代理必须删除 safety_check')
  assert.equal(sent.model, 'deepseek-flash')
  const messageRequest = upstream.requests.filter((item) => item.path === '/anthropic/v1/messages').at(-1)
  assert.equal(messageRequest.headers.authorization, 'Bearer sk-valid-key-123456')

  // 附件上传（multipart）也走代理
  const form = new FormData()
  form.append('purpose', 'user_data')
  form.append('file', new Blob([new Uint8Array([1, 2, 3])]), 'demo.txt')
  const upload = await fetch(`${base}/api/ds/anthropic/v1/files`, {
    method: 'POST',
    headers: { cookie: client.cookie },
    body: form,
  })
  assert.equal(upload.status, 200)
  assert.equal((await upload.json()).id, 'file-api-test-1')
  const fileRequest = upstream.requests.filter((item) => item.path === '/anthropic/v1/files').at(-1)
  assert.match(fileRequest.headers['content-type'], /multipart\/form-data/)
  assert.match(fileRequest.body.toString('utf8'), /demo\.txt/)

  // 语音接口透传
  const tts = await client.call('POST', '/api/ds/v1/tools/tts', {
    body: { text: '你好', voice_id: 'stella', format: 'pcm', filter_markdown: true },
  })
  assert.equal(tts.status, 200)
  assert.equal(tts.headers.get('content-type'), 'application/octet-stream')
})

test('代理：未绑定 Key 与未配置默认 Key 时返回 401', async () => {
  const { base } = await startApp()
  const client = makeClient(base)
  await register(client)
  const response = await client.call('POST', '/api/ds/anthropic/v1/messages', {
    body: { model: 'deepseek-flash', messages: [], stream: true },
  })
  assert.equal(response.status, 401)
  assert.equal(response.json.error.code, 'no_api_key')
})

test('代理：服务器默认 Key 可在账号未绑定时使用', async () => {
  const { base, upstream } = await startApp({ defaultApiKey: 'sk-server-default' })
  const client = makeClient(base)
  await register(client)
  const response = await client.call('POST', '/api/ds/anthropic/v1/messages', {
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
  })
  assert.equal(response.status, 200)
  const request = upstream.requests.filter((item) => item.path === '/anthropic/v1/messages').at(-1)
  assert.equal(request.headers.authorization, 'Bearer sk-server-default')
  const account = await client.call('GET', '/api/account')
  assert.equal(account.json.account.usingServerApiKey, true)
})

test('置顶：置顶会话排在最前，可取消', async () => {
  const { base } = await startApp()
  const client = makeClient(base)
  await register(client)

  await client.call('PUT', '/api/sessions/sess-old', {
    body: { session: { ...sampleSession('sess-old', '旧会话'), updatedAt: 1700000001000 } },
  })
  await client.call('PUT', '/api/sessions/sess-new', {
    body: { session: { ...sampleSession('sess-new', '新会话'), updatedAt: 1700000009000 } },
  })

  let list = await client.call('GET', '/api/sessions')
  assert.deepEqual(
    list.json.sessions.map((item) => item.id),
    ['sess-new', 'sess-old']
  )

  const pinned = await client.call('PATCH', '/api/sessions/sess-old', { body: { pinned: true } })
  assert.equal(pinned.status, 200)
  list = await client.call('GET', '/api/sessions')
  assert.deepEqual(
    list.json.sessions.map((item) => item.id),
    ['sess-old', 'sess-new']
  )
  assert.equal(list.json.sessions[0].pinned, true)

  // 重命名不影响置顶
  await client.call('PATCH', '/api/sessions/sess-old', { body: { title: '改个名' } })
  list = await client.call('GET', '/api/sessions')
  assert.equal(list.json.sessions[0].pinned, true)
  assert.equal(list.json.sessions[0].title, '改个名')

  await client.call('PATCH', '/api/sessions/sess-old', { body: { pinned: false } })
  list = await client.call('GET', '/api/sessions')
  assert.deepEqual(
    list.json.sessions.map((item) => item.id),
    ['sess-new', 'sess-old']
  )
})

test('历史导入：追加模式保留现有对话，id 冲突自动换新', async () => {
  const { base } = await startApp()
  const client = makeClient(base)
  await register(client)

  // 现有两条对话
  await client.call('PUT', '/api/sessions/sess-keep', {
    body: { session: sampleSession('sess-keep', '已有对话') },
  })
  await client.call('PUT', '/api/sessions/sess-dup', {
    body: { session: sampleSession('sess-dup', '会被重复导入的对话') },
  })

  // 暂存一条 id 冲突 + 一条全新
  await client.call('POST', '/api/import/reset')
  await client.call('PUT', '/api/import/sessions/sess-dup', {
    body: { session: sampleSession('sess-dup', '导入的同名对话') },
  })
  await client.call('PUT', '/api/import/sessions/sess-fresh', {
    body: { session: sampleSession('sess-fresh', '新导入对话') },
  })

  const appended = await client.call('POST', '/api/import/commit', { body: { mode: 'append' } })
  assert.equal(appended.status, 200)
  assert.equal(appended.json.mode, 'append')
  const list = await client.call('GET', '/api/sessions')
  assert.equal(list.json.sessions.length, 4, '原有 2 条 + 追加 2 条')
  const titles = list.json.sessions.map((item) => item.title)
  assert.ok(titles.includes('已有对话'))
  assert.ok(titles.includes('会被重复导入的对话'))
  assert.ok(titles.includes('导入的同名对话'))
  assert.ok(titles.includes('新导入对话'))
  // 原会话内容没有被替换
  assert.equal((await client.call('GET', '/api/sessions/sess-dup')).json.session.title, '会被重复导入的对话')
  // 追加的会话带用量汇总
  const imported = list.json.sessions.find((item) => item.id === 'sess-fresh')
  assert.equal(imported.usage.offPeak.searches, 1)

  // 替换模式仍然可用
  await client.call('POST', '/api/import/reset')
  await client.call('PUT', '/api/import/sessions/only-one', {
    body: { session: sampleSession('only-one', '唯一对话') },
  })
  const replaced = await client.call('POST', '/api/import/commit', { body: { mode: 'replace' } })
  assert.equal(replaced.json.sessions.length, 1)
  assert.equal(replaced.json.sessions[0].id, 'only-one')
})

test('账号用量汇总：累计所有会话的 token 与联网次数', async () => {
  const { base } = await startApp()
  const client = makeClient(base)
  await register(client)

  await client.call('PUT', '/api/sessions/s1', { body: { session: sampleSession('s1') } })
  await client.call('PUT', '/api/sessions/s2', { body: { session: sampleSession('s2') } })

  const account = await client.call('GET', '/api/account')
  assert.equal(account.status, 200)
  const usage = account.json.account.usage
  assert.equal(usage.offPeak.inputMiss, 200)
  assert.equal(usage.offPeak.cacheHit, 100)
  assert.equal(usage.offPeak.output, 40)
  assert.equal(usage.offPeak.searches, 2)

  // 删除一条对话后合计随之减少
  await client.call('DELETE', '/api/sessions/s1')
  const after = await client.call('GET', '/api/account')
  assert.equal(after.json.account.usage.offPeak.inputMiss, 100)
  assert.equal(after.json.account.usage.offPeak.searches, 1)
})

test('跨站写请求被拒绝', async () => {
  const { base } = await startApp()
  const client = makeClient(base)
  await register(client)
  const response = await client.call('POST', '/api/import/reset', {
    headers: { origin: 'https://evil.example.com' },
  })
  assert.equal(response.status, 403)
})
