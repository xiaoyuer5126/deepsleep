import { useTranslate } from '../../i18n/index.js'
import { useAuth } from '../../services/auth.js'
import { TRANSCRIBE_MODEL } from '../../services/chat/reply.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { estimateCost, formatCost } from '../../services/pricing.js'
import styles from './MessageCost.module.css'

/**
 * 回答下方的模型标记与 token 费用估算（仅供参考，以 DeepSeek 账单为准）。
 * - Pro 回答标出模型；先由 flash 转写过图片的，标出转写，转写费用按 flash 单价计入本条
 * - 单价由服务端下发，可在 PRICING_JSON 中调整
 */
export const MessageCost = ({ message }: { message: AssistantMessage }) => {
  const t = useTranslate()
  // 订阅服务端价格配置，配置更新后重新估算
  const pricing = useAuth((state) => state.config?.pricing)
  const cost = pricing ? estimateCost(message.usage, message.model, message.createdAt) : null
  const transcription = message.transcription
  const transcriptionCost =
    pricing && transcription
      ? estimateCost(transcription.usage, TRANSCRIBE_MODEL, message.createdAt).total
      : 0
  const total = (cost?.total ?? 0) + transcriptionCost
  const formatted = formatCost(total)
  return (
    <>
      {message.model === 'deepseek-v4-pro' ? (
        <span className={styles.cost} title={t('messageModelProTooltip')}>
          {t('messageModelPro')}
        </span>
      ) : null}
      {transcription && transcription.images > 0 ? (
        <span
          className={styles.cost}
          title={t('messageTranscribedTooltip', {
            count: transcription.images,
            cost: formatCost(transcriptionCost),
          })}
        >
          {t('messageTranscribedLabel')}
        </span>
      ) : null}
      {cost && total > 0 ? (
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
      ) : null}
    </>
  )
}
