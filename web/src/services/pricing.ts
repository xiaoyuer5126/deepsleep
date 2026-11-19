import type { ChatModel, MessageUsage } from './api/types.js'
import { useAuth } from './auth.js'

/**
 * 服务端下发的单价配置（元 / 百万 token），默认值与 DeepSeek 官方价格页一致。
 * 计费口径见官方文档《使用 Anthropic API》与《联网工具 · 用量与计费》：
 * - input_tokens 是未命中缓存的输入，cache_read_input_tokens 是命中缓存的输入
 * - 联网按 tool_search（文字）+ tool_image_search（图片）+ tool_fetch（抓取）计费，
 *   web_search_requests / web_fetch_requests 只是展示用的块数量，不计费
 * - 高峰时段（北京时间周一至周五 9:00-12:00、14:00-18:00，不含法定节假日）价格翻倍
 */
export type PricingConfig = {
  currency: string
  models: Record<string, { inputCacheHit: number; inputCacheMiss: number; output: number }>
  peakMultiplier: number
  peakWindows: [number, number][]
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

export const getPricing = (): PricingConfig => useAuth.getState().config?.pricing ?? FALLBACK

/** 高峰时段窗口（北京时间）；配置缺失时的兜底 */
export const DEFAULT_PEAK_WINDOWS: [number, number][] = [
  [9, 12],
  [14, 18],
]

/** 北京时间周一至周五的高峰时段判断（法定节假日未单独扣除，属于估算） */
export const isPeakTime = (timestamp: number, windows: [number, number][]): boolean => {
  const beijing = new Date(timestamp + 8 * 60 * 60 * 1000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const hour = beijing.getUTCHours()
  return windows.some(([start, end]) => hour >= start && hour < end)
}

/** 一段用量：token 分输入未命中 / 缓存命中 / 输出，searches 为计费的联网次数 */
export type UsageBucket = {
  inputMiss: number
  cacheHit: number
  output: number
  searches: number
}

/** 会话用量按高峰 / 空闲分桶（服务端汇总后下发，侧边栏据此显示每条对话的费用） */
export type SessionUsage = { peak: UsageBucket; offPeak: UsageBucket }

export type CostBreakdown = {
  total: number
  inputMiss: number
  cacheHit: number
  output: number
  searches: number
}

const ZERO: CostBreakdown = { total: 0, inputMiss: 0, cacheHit: 0, output: 0, searches: 0 }

/** 单条消息的计费用量（按同样口径把 usage 归一化） */
const bucketFromMessage = (usage: MessageUsage): UsageBucket => {
  const tools = usage.server_tool_use ?? {}
  return {
    inputMiss: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
    cacheHit: usage.cache_read_input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    searches:
      (tools.tool_search ?? 0) + (tools.tool_image_search ?? 0) + (tools.tool_fetch ?? 0),
  }
}

const bucketPrice = (
  bucket: UsageBucket,
  modelPricing: { inputCacheHit: number; inputCacheMiss: number; output: number },
  multiplier: number,
  webRequestPrice: number
): number =>
  (bucket.inputMiss * modelPricing.inputCacheMiss +
    bucket.cacheHit * modelPricing.inputCacheHit +
    bucket.output * modelPricing.output) /
    1_000_000 *
    multiplier +
  bucket.searches * webRequestPrice

/** 按 usage 估算一条回答的费用；模型未知时按 deepseek-flash 计。 */
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
  const bucket = bucketFromMessage(usage)
  const multiplier = isPeakTime(at, pricing.peakWindows) ? pricing.peakMultiplier : 1
  return {
    total: bucketPrice(bucket, modelPricing, multiplier, pricing.webRequestPrice),
    ...bucket,
  }
}

/** 估算整条会话的费用（侧边栏用）；会话用量不区分模型，统一按 deepseek-flash 单价。 */
export const estimateSessionCost = (usage: SessionUsage | undefined | null): number => {
  if (!usage) {
    return 0
  }
  const pricing = getPricing()
  const modelPricing = pricing.models['deepseek-flash']
  if (!modelPricing) {
    return 0
  }
  const offPeak = bucketPrice(
    usage.offPeak ?? { inputMiss: 0, cacheHit: 0, output: 0, searches: 0 },
    modelPricing,
    1,
    pricing.webRequestPrice
  )
  const peak = bucketPrice(
    usage.peak ?? { inputMiss: 0, cacheHit: 0, output: 0, searches: 0 },
    modelPricing,
    pricing.peakMultiplier,
    pricing.webRequestPrice
  )
  return offPeak + peak
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
