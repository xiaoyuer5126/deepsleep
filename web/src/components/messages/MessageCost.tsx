import { useTranslate } from '../../i18n/index.js'
import { useAuth } from '../../services/auth.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { estimateCost, formatCost } from '../../services/pricing.js'
import styles from './MessageCost.module.css'

/**
 * 单条回答的 token 费用估算（仅供参考，以 DeepSeek 账单为准）。
 * 单价由服务端下发，可在 PRICING_JSON 中调整。
 */
export const MessageCost = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  // 订阅服务端价格配置，配置更新后重新估算
  const pricing = useAuth((state) => state.config?.pricing)
  if (!message.usage || !pricing) {
    return null
  }
  const cost = estimateCost(message.usage, message.model, message.createdAt)
  if (cost.total <= 0) {
    return null
  }
  const formatted = formatCost(cost.total)
  return (
    <span
      className={styles.cost}
      title={t('messageCostTooltip', {
        cost: formatted,
        input: cost.inputMiss,
        cached: cost.cacheHit,
        output: cost.output,
        searches: cost.searches,
      })}
    >
      {t('messageCostLabel', { cost: formatted })}
    </span>
  )
}
