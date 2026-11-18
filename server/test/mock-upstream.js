import http from 'node:http'

/** 模拟 DeepSeek API 的上游服务，用来在容器里跑端到端测试，不需要真实 Key。 */

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })

const sse = (res, events) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  for (const [event, data] of events) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  res.end()
}

const messageEvents = [
  [
    'message_start',
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'deepseek-flash',
        content: [],
        stop_reason: null,
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      },
    },
  ],
  [
    'content_block_start',
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  ],
  [
    'content_block_delta',
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: '先想一想。' },
    },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  [
    'content_block_start',
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  ],
  [
    'content_block_delta',
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好！' } },
  ],
  ['content_block_stop', { type: 'content_block_stop', index: 1 }],
  [
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, title: '测试会话标题' },
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 4096,
        output_tokens: 18,
        server_tool_use: { web_search_requests: 1, tool_search: 0 },
      },
    },
  ],
  ['message_stop', { type: 'message_stop' }],
]

export const startMockUpstream = async ({ port = 0 } = {}) => {
  const requests = []
  let messageBodies = []

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://upstream.test')
    const body = await readBody(req)
    requests.push({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body,
    })

    if (url.pathname === '/models' && req.method === 'GET') {
      const key = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
      if (!key || key === 'sk-invalid') {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] }))
      return
    }

    if (url.pathname === '/anthropic/v1/files' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          id: 'file-api-test-1',
          type: 'file',
          filename: 'upload.bin',
          bytes: body.length,
          purpose: 'user_data',
        })
      )
      return
    }

    if (url.pathname.startsWith('/anthropic/v1/files/') && req.method === 'DELETE') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ id: 'file-api-test-1', deleted: true }))
      return
    }

    if (url.pathname === '/anthropic/v1/messages' && req.method === 'POST') {
      let parsed = null
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        parsed = null
      }
      messageBodies.push(parsed)
      sse(res, messageEvents)
      return
    }

    if (url.pathname === '/v1/tools/asr' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ text: '语音转写结果' }))
      return
    }

    if (url.pathname === '/v1/tools/tts' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `no mock for ${req.method} ${url.pathname}` } }))
  })

  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve))
  const address = server.address()
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get messageBodies() {
      return messageBodies
    },
    reset() {
      requests.length = 0
      messageBodies = []
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  }
}
