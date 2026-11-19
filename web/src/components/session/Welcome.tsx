import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import type { TranslationKey } from '../../i18n/index.js'
import { useAuth } from '../../services/auth.js'
import { DEFAULT_PEAK_WINDOWS, isPeakTime } from '../../services/pricing.js'
import { ChatInput } from '../chatInput/ChatInput.js'
import { MobileHeader } from './MobileHeader.js'
import styles from './Welcome.module.css'

/** 按当前北京时间选择问候语，与网页端一致 */
const greetingKey = (): TranslationKey => {
  const hour = new Date(Date.now() + 8 * 60 * 60 * 1000).getUTCHours()
  if (hour >= 18 || hour < 5) {
    return 'welcomeGreetingEvening'
  }
  if (hour < 12) {
    return 'welcomeGreetingMorning'
  }
  return 'welcomeGreetingAfternoon'
}

/** 新对话：图标 + 时段问候语（含当前是高峰/空闲时段）+ 输入框。桌面端居中；移动端输入框吸底 */
export const Welcome = () => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  // 与费用估算同一套规则：北京时间周一至周五 9-12、14-18 为高峰
  const peakWindows = useAuth((state) => state.config?.pricing?.peakWindows)
  const peak = isPeakTime(Date.now(), peakWindows ?? DEFAULT_PEAK_WINDOWS)
  const greeting = t(peak ? 'welcomeGreetingPeak' : 'welcomeGreetingOffPeak', {
    greeting: t(greetingKey()),
    period: t(peak ? 'welcomePeriodPeak' : 'welcomePeriodOffPeak'),
  })
  return (
    <div className={styles.container}>
      {isMobile ? <MobileHeader /> : null}
      <div className={styles.welcome}>
        <div className={styles.greeting}>
          <img className={styles.greetingLogo} src="assets/favicon.svg" alt="" width={48} height={48} />
          <span className={styles.greetingText} title={t('welcomePeriodHint')}>
            {greeting}
          </span>
        </div>
        <ChatInput sessionId={null} />
        {isMobile ? <div className={styles.caveat}>{t('contentCaveat')}</div> : null}
      </div>
    </div>
  )
}
