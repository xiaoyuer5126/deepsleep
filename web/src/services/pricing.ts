import type { MessageUsage } from './api/types.js'
import { useAuth } from './auth.js'
import type { ChatModel } from './api/types.js'

/** 服务端下发的单价配置（元 / 百万 token），默认值与 DeepSeek 官方价格页一致。 */
export type PricingConfig = {
  currency: string
  models: Record<string, { inputCacheHit: number; inputCacheMiss: number; output: number }>
  /** 高峰时段单价倍数（默认 2 倍） */
  peakMultiplier: number
  /** 高峰小时区间（北京时间），如 [[9,12],[14,18]] */
  peakWindows: [number, number][]
  /** 联网搜索 / 网页抓取每次价格 */
  webRequestPrice: number
}

const FALLBACK: PricingConfig = {
  currency: 'CNY',
  models: {
    'deepseek-flash': { inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 },
    'deepseek-v4-pro': { inputCacheHit: 0.15, inputCacheMiss: 4.5, output: 13.5 },
  },
  peakMultiplier: 2,
  peakWindows: [
    [9, 12],
    [14, 18],
  ],
  webRequestPrice: 0.005,
}

export const getPricing = (): PricingConfig =>
  useAuth.getState().config?.pricing ?? FALLBACK

/** 北京时间周一至周五 9:00-12:00、14:00-18:00 为高峰时段（不含法定节假日，近似判断）。 */
export const isPeakTime = (timestamp: number, windows: [number, number][]): boolean => {
  const beijing = new Date(timestamp + 8 * 60 * 60 * 1000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const hour = beijing.getUTCHours()
  return windows.some(([start, end]) => hour >= start && hour < end)
}

export type CostBreakdown = {
  total: number
  inputMiss: number
  cacheHit: number
  output: number
  searches: number
}

const ZERO: CostBreakdown = { total: 0, inputMiss: 0, cacheHit: 0, output: 0, searches: 0 }

/** 按 usage 估算一次回答的费用；模型未知时按 deepseek-flash 计。 */
export const estimateCost = (
  usage: MessageUsage | undefined,
  model: ChatModel | null,
  at: number
): CostBreakdown => {
  if (!usage) {
    return ZERO
  }
  const pricing = getPricing()
  const modelPricing = pricing.models[model ?? ''] ?? pricing.models['deepseek-flash']
  if (!modelPricing) {
    return ZERO
  }
  const multiplier = isPeakTime(at, pricing.peakWindows) ? pricing.peakMultiplier : 1
  // input_tokens 不含缓存读写，缓存写入按未命中价计（与官方计费口径一致）
  const inputMiss = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0)
  const cacheHit = usage.cache_read_input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const searches =
    (usage.server_tool_use?.web_search_requests ?? 0) + (usage.server_tool_use?.tool_search ?? 0)
  const tokenPrice =
    (inputMiss * modelPricing.inputCacheMiss +
      cacheHit * modelPricing.inputCacheHit +
      output * modelPricing.output) /
    1_000_000
  const total = tokenPrice * multiplier + searches * pricing.webRequestPrice
  return { total, inputMiss, cacheHit, output, searches }
}

/** 金额展示：小额保留 4 位小数，大额保留 2 位。 */
export const formatCost = (value: number): string => {
  if (value <= 0) {
    return '0'
  }
  if (value < 0.0001) {
    return '0.0001'
  }
  return value < 1 ? value.toFixed(4) : value.toFixed(2)
}
