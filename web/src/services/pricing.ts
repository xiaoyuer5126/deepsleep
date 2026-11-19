import type { ChatModel, MessageUsage } from './api/types.js'
import { useAuth } from './auth.js'
import {
  estimateCost as estimateCostWith,
  estimateSessionCost as estimateSessionCostWith,
  FALLBACK_PRICING,
  type CostBreakdown,
  type PricingConfig,
  type SessionUsage,
} from './pricingMath.js'

export * from './pricingMath.js'

export const getPricing = (): PricingConfig =>
  useAuth.getState().config?.pricing ?? FALLBACK_PRICING

/** 按当前单价估算一次请求的费用；模型未知时按 deepseek-flash 计。 */
export const estimateCost = (
  usage: MessageUsage | undefined,
  model: ChatModel | null,
  at: number
): CostBreakdown => estimateCostWith(usage, model, at, getPricing())

/** 按当前单价估算整条会话（或整个账号）的费用：pro 部分按 pro 单价，其余按 flash 单价。 */
export const estimateSessionCost = (usage: SessionUsage | undefined | null): number =>
  estimateSessionCostWith(usage, getPricing())
