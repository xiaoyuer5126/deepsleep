/**
 * 费用估算：单价默认取自 DeepSeek 官方价格页（2026-11，人民币 / 百万 token）。
 * 计费口径（来自官方文档《使用 Anthropic API》与《联网工具 · 用量与计费》）：
 * - input_tokens：未命中上下文缓存的输入 Token
 * - cache_read_input_tokens：命中缓存的输入 Token（便宜很多）
 * - output_tokens：输出 Token（含思考）
 * - cache_creation_input_tokens 目前恒为 0，若出现按未命中价计
 * - 联网：按 tool_search（文字搜索）、tool_image_search（图片搜索）、tool_fetch（网页抓取）计费；
 *   web_search_requests / web_fetch_requests 只是展示用的块数量，不是计费次数
 * - 高峰时段（北京时间周一至周五 9:00-12:00、14:00-18:00，不含法定节假日）单价翻倍
 */

export const DEFAULT_PRICING = {
  currency: 'CNY',
  unit: 'per_million_tokens',
  models: {
    'deepseek-flash': { inputCacheHit: 0.02, inputCacheMiss: 1, output: 4 },
    'deepseek-v4-pro': { inputCacheHit: 0.15, inputCacheMiss: 4.5, output: 13.5 },
  },
  peakMultiplier: 2,
  peakWindows: [
    [9, 12],
    [14, 18],
  ],
  /** 联网搜索 / 图片搜索 / 网页抓取：5 元 / 1000 次 */
  webRequestPrice: 0.005,
}

/** 北京时间周一至周五的高峰时段判断（法定节假日无法在本地判断，属于近似） */
export const isPeakTime = (timestamp, windows) => {
  const beijing = new Date(timestamp + 8 * 60 * 60 * 1000)
  const day = beijing.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const hour = beijing.getUTCHours()
  return windows.some(([start, end]) => hour >= start && hour < end)
}

const emptyBucket = () => ({ inputMiss: 0, cacheHit: 0, output: 0, searches: 0 })

const addToBucket = (bucket, usage) => {
  bucket.inputMiss += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  bucket.cacheHit += usage.cache_read_input_tokens ?? 0
  bucket.output += usage.output_tokens ?? 0
  const tools = usage.server_tool_use ?? {}
  bucket.searches +=
    (tools.tool_search ?? 0) + (tools.tool_image_search ?? 0) + (tools.tool_fetch ?? 0)
}

/** 按 deepseek-v4-pro 单价计费的模型 */
export const PRO_MODEL = 'deepseek-v4-pro'

/**
 * 汇总一条会话里的用量，按「高峰 / 空闲」分桶保存，便于前端用当前单价即时换算。
 * 返回 { peak, offPeak, pro: { peak, offPeak } }：peak / offPeak 是全部用量，
 * pro 是其中 deepseek-v4-pro 回答的那部分，其余按 deepseek-flash 计价。
 * 回答的 transcription 是发给 pro 前用 deepseek-flash 转写图片的用量，计入 flash。
 */
export const summarizeSessionUsage = (messages, windows = DEFAULT_PRICING.peakWindows, now = Date.now()) => {
  const summary = {
    peak: emptyBucket(),
    offPeak: emptyBucket(),
    pro: { peak: emptyBucket(), offPeak: emptyBucket() },
  }
  if (!Array.isArray(messages)) {
    return summary
  }
  for (const message of messages) {
    if (!message || message.role !== 'assistant') {
      continue
    }
    const key = isPeakTime(Number.isFinite(message.createdAt) ? message.createdAt : now, windows)
      ? 'peak'
      : 'offPeak'
    if (message.usage) {
      addToBucket(summary[key], message.usage)
      if (message.model === PRO_MODEL) {
        addToBucket(summary.pro[key], message.usage)
      }
    }
    if (message.transcription?.usage) {
      addToBucket(summary[key], message.transcription.usage)
    }
  }
  return summary
}

/** 会话用量是否全为 0（全为 0 时不必展示费用） */
export const isEmptyUsage = (summary) => {
  if (!summary) {
    return true
  }
  return ['peak', 'offPeak'].every((key) => {
    const bucket = summary[key] ?? {}
    return !bucket.inputMiss && !bucket.cacheHit && !bucket.output && !bucket.searches
  })
}
