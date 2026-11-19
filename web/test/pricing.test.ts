// 运行：pnpm test。核对侧边栏 / 账号页的累计费用 = 每条回答按各自模型单价算出的费用之和。
import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-expect-error 服务端是纯 JS，没有类型声明
import { summarizeSessionUsage } from '../../server/pricing.js'
import { estimateCost, estimateSessionCost, FALLBACK_PRICING } from '../src/services/pricingMath.ts'
import type { ChatModel, MessageUsage } from '../src/services/api/types.ts'

const pricing = FALLBACK_PRICING
const PEAK = Date.parse('2026-11-19T02:00:00Z') // 北京时间周四 10:00，高峰
const OFF_PEAK = Date.parse('2026-11-19T13:00:00Z') // 北京时间周四 21:00，空闲

const usage = (input: number, cached: number, output: number, searches = 0): MessageUsage => ({
  input_tokens: input,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: cached,
  output_tokens: output,
  server_tool_use: { tool_search: searches },
})

type Reply = {
  model: ChatModel
  createdAt: number
  usage: MessageUsage
  transcription?: { usage: MessageUsage; images: number }
}

const replies: Reply[] = [
  { model: 'deepseek-flash', createdAt: OFF_PEAK, usage: usage(1000, 500, 200, 1) },
  { model: 'deepseek-v4-pro', createdAt: OFF_PEAK, usage: usage(3000, 2000, 800) },
  {
    model: 'deepseek-v4-pro',
    createdAt: PEAK,
    usage: usage(5000, 0, 1200, 2),
    transcription: { usage: usage(800, 0, 300), images: 1 },
  },
  { model: 'deepseek-flash', createdAt: PEAK, usage: usage(200, 100, 50) },
]

test('累计费用等于每条回答按各自模型单价单独算再相加', () => {
  const perReply = replies.reduce(
    (sum, reply) =>
      sum +
      estimateCost(reply.usage, reply.model, reply.createdAt, pricing).total +
      (reply.transcription
        ? estimateCost(reply.transcription.usage, 'deepseek-flash', reply.createdAt, pricing).total
        : 0),
    0
  )
  const messages = replies.map((reply, index) => ({
    id: `a${index}`,
    role: 'assistant',
    ...reply,
  }))
  const total = estimateSessionCost(summarizeSessionUsage(messages), pricing)
  assert.ok(Math.abs(total - perReply) < 1e-12, `${total} ≠ ${perReply}`)
})

test('pro 回答按 pro 单价算，同样的用量比 flash 贵', () => {
  const same = usage(1_000_000, 0, 0)
  assert.equal(estimateCost(same, 'deepseek-flash', OFF_PEAK, pricing).total, 1)
  assert.equal(estimateCost(same, 'deepseek-v4-pro', OFF_PEAK, pricing).total, 4.5)
  assert.equal(estimateCost(same, 'deepseek-v4-pro', PEAK, pricing).total, 9)
})
