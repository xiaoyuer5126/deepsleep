import { useState, type FormEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { login, register, useAuth } from '../../services/auth.js'
import { setLocale, useSettings } from '../../services/settings.js'
import styles from './AuthScreen.module.css'

/** 登录 / 注册页：账号密码登录，多端共用同一份历史与 API Key。 */
export const AuthScreen = () => {
  const t = useTranslate()
  const config = useAuth((state) => state.config)
  const notice = useAuth((state) => state.notice)
  const locale = useSettings((state) => state.locale)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const registering = mode === 'register'
  const canRegister = config?.allowRegistration !== false

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) {
      return
    }
    setError(null)
    const name = username.trim()
    if (!name || !password) {
      setError(t('authUsername') + ' / ' + t('authPassword'))
      return
    }
    if (registering && password !== confirm) {
      setError(t('authPasswordMismatch'))
      return
    }
    if (registering && config?.requireInviteCode && !inviteCode.trim()) {
      setError(t('authInviteRequired'))
      return
    }
    setBusy(true)
    try {
      if (registering) {
        await register(name, password, inviteCode.trim())
      } else {
        await login(name, password)
      }
      // 成功后由 App 切换到对话界面
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.glows} aria-hidden="true" />
      <div className={styles.brand}>{t('appName')}</div>
      <form className={styles.card} onSubmit={(event) => void submit(event)}>
        <h1 className={styles.title}>{t(registering ? 'authRegisterTitle' : 'authLoginTitle')}</h1>
        <p className={styles.subtitle}>{t('authWelcome')}</p>
        {notice === 'expired' ? <div className={styles.notice}>{t('authExpired')}</div> : null}

        <label className={styles.field}>
          <span className={styles.label}>{t('authUsername')}</span>
          <input
            className={styles.input}
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            placeholder={t('authUsernameHint')}
            maxLength={32}
            autoFocus
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t('authPassword')}</span>
          <input
            className={styles.input}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={registering ? 'new-password' : 'current-password'}
            placeholder={t('authPasswordHint')}
            maxLength={200}
          />
        </label>

        {registering ? (
          <label className={styles.field}>
            <span className={styles.label}>{t('authPasswordConfirm')}</span>
            <input
              className={styles.input}
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              maxLength={200}
            />
          </label>
        ) : null}

        {registering && config?.requireInviteCode ? (
          <label className={styles.field}>
            <span className={styles.label}>{t('authInviteCode')}</span>
            <input
              className={styles.input}
              value={inviteCode}
              onChange={(event) => setInviteCode(event.target.value)}
              maxLength={200}
            />
          </label>
        ) : null}

        {error ? (
          <div className={styles.error} role="alert">
            {error}
          </div>
        ) : null}

        <button className={styles.submit} type="submit" disabled={busy}>
          {busy
            ? t(registering ? 'authRegistering' : 'authLoggingIn')
            : t(registering ? 'authRegister' : 'authLogin')}
        </button>

        {canRegister ? (
          <div className={styles.switchRow}>
            <span>{t(registering ? 'authHasAccount' : 'authNoAccount')}</span>
            <button
              type="button"
              className={styles.switchButton}
              onClick={() => {
                setMode(registering ? 'login' : 'register')
                setError(null)
              }}
            >
              {t(registering ? 'authGoLogin' : 'authGoRegister')}
            </button>
          </div>
        ) : (
          <div className={styles.switchRow}>{t('authRegistrationClosed')}</div>
        )}
      </form>
      <div className={styles.footer}>
        <button
          type="button"
          className={styles.localeButton}
          onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}
        >
          {locale === 'zh-CN' ? 'English' : '简体中文'}
        </button>
      </div>
    </div>
  )
}
