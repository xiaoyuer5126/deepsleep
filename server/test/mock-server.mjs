import { startMockUpstream } from './mock-upstream.js'

/** 独立运行 mock DeepSeek API，供 docker-compose.test.yml 中的 web 服务联调使用。 */
const port = Number.parseInt(process.env.MOCK_PORT ?? '4010', 10)
const upstream = await startMockUpstream({ port })
// eslint-disable-next-line no-console
console.log(`[mock] DeepSeek API mock listening on ${upstream.url}`)

const shutdown = async () => {
  await upstream.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
