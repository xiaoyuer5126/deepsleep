import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { TranslationKey } from '../../i18n/index.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 按当前时段选择问候语，与网页端一致 */
const greetingKey = (): TranslationKey => {
  const hour = new Date().getHours()
  if (hour >= 18 || hour < 5) {
    return 'welcomeGreetingEvening'
  }
  if (hour < 12) {
    return 'welcomeGreetingMorning'
  }
  return 'welcomeGreetingAfternoon'
}

/** 新对话：图标 + 时段问候语 + 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>
          <img className={styles.greetingLogo} src="assets/favicon.svg" alt="" width={48} height={48} />
          <span className={styles.greetingText}>
            {t('welcomeGreetingLine', { greeting: t(greetingKey()) })}
          </span>
        </div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
