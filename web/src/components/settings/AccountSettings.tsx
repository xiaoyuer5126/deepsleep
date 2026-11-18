import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  changePassword,
  logout,
  refreshAccount,
  removeApiKey,
  saveApiKey,
  useAuth,
} from '../../services/auth.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './AccountSettings.module.css'

/**
 * 账号设置：展示用户名、绑定/解除本账号的 API Key（服务端加密保存，多端共用）、
 * 修改密码与退出登录。API Key 在浏览器里只提交一次，之后只显示掩码。
 */
export const AccountSettings = () => {
  const t = useTranslate()
  const user = useAuth((state) => state.user)
  const config = useAuth((state) => state.config)
  const [apiKey, setApiKey] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [keyBusy, setKeyBusy] = useState(false)
  const [keyStatus, setKeyStatus] = useState<string | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [passwordBusy, setPasswordBusy] = useState(false)
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [logoutOpen, setLogoutOpen] = useState(false)
  const [logoutBusy, setLogoutBusy] = useState(false)

  useEffect(() => {
    void refreshAccount()
  }, [])

  if (!user) {
    return null
  }

  const serverKeyAvailable = user.usingServerApiKey || config?.hasDefaultApiKey === true
  const showKeyForm = !user.hasApiKey || editingKey

  const onSaveKey = async () => {
    const value = apiKey.trim()
    if (!value || keyBusy) {
      return
    }
    setKeyBusy(true)
    setKeyError(null)
    setKeyStatus(null)
    try {
      await saveApiKey(value)
      setApiKey('')
      setEditingKey(false)
      setKeyStatus(t('accountApiKeySaved'))
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error))
    } finally {
      setKeyBusy(false)
    }
  }

  const onRemoveKey = async () => {
    if (keyBusy) {
      return
    }
    setKeyBusy(true)
    setKeyError(null)
    setKeyStatus(null)
    try {
      await removeApiKey()
      setKeyStatus(t('accountApiKeyRemoved'))
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : String(error))
    } finally {
      setKeyBusy(false)
    }
  }

  const onChangePassword = async () => {
    if (passwordBusy || !currentPassword || !newPassword || newPassword.length < 8) {
      return
    }
    setPasswordBusy(true)
    setPasswordError(null)
    setPasswordStatus(null)
    try {
      await changePassword(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
      setPasswordStatus(t('accountPasswordChanged'))
    } catch (error) {
      setPasswordError(
        t('accountPasswordFailed', {
          message: error instanceof Error ? error.message : String(error),
        })
      )
    } finally {
      setPasswordBusy(false)
    }
  }

  const keyState = user.hasApiKey
    ? t('accountApiKeyBound', { mask: user.apiKeyMasked || '****' })
    : serverKeyAvailable
      ? t('accountApiKeyServerDefault')
      : t('accountApiKeyMissing')

  return (
    <div className={styles.container}>
      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('accountUsername')}</div>
        </div>
        <div className={styles.value}>{user.username}</div>
      </div>

      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('accountApiKey')}</div>
          <div className={styles.description}>{keyState}</div>
        </div>
        {user.hasApiKey && !editingKey ? (
          <div className={styles.actions}>
            <Button variant="outlined" size="m" onClick={() => setEditingKey(true)}>
              {t('apiKeyEdit')}
            </Button>
            <Button
              variant="dangerOutlined"
              size="m"
              disabled={keyBusy}
              onClick={() => void onRemoveKey()}
            >
              {t('accountApiKeyRemove')}
            </Button>
          </div>
        ) : null}
      </div>

      {showKeyForm ? (
        <div className={styles.form}>
          <div className={styles.formRow}>
            <input
              className={styles.input}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t('accountApiKeyPlaceholder')}
              type="password"
              autoComplete="off"
              spellCheck={false}
              maxLength={500}
            />
            <Button size="m" disabled={keyBusy || !apiKey.trim()} onClick={() => void onSaveKey()}>
              {keyBusy ? t('accountApiKeySaving') : t('accountApiKeySave')}
            </Button>
            {user.hasApiKey ? (
              <Button
                variant="outlined"
                size="m"
                disabled={keyBusy}
                onClick={() => {
                  setEditingKey(false)
                  setApiKey('')
                  setKeyError(null)
                }}
              >
                {t('cancel')}
              </Button>
            ) : null}
          </div>
          <div className={styles.hint}>{t('accountApiKeyHint')}</div>
          {keyStatus ? <div className={styles.success}>{keyStatus}</div> : null}
          {keyError ? <div className={styles.error}>{keyError}</div> : null}
        </div>
      ) : keyStatus || keyError ? (
        <div className={styles.form}>
          {keyStatus ? <div className={styles.success}>{keyStatus}</div> : null}
          {keyError ? <div className={styles.error}>{keyError}</div> : null}
        </div>
      ) : null}

      <div className={styles.sectionTitle}>{t('accountChangePassword')}</div>
      <div className={styles.form}>
        <div className={styles.formRow}>
          <input
            className={styles.input}
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            placeholder={t('accountCurrentPassword')}
            type="password"
            autoComplete="current-password"
            maxLength={200}
          />
          <input
            className={styles.input}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder={t('accountNewPassword')}
            type="password"
            autoComplete="new-password"
            maxLength={200}
          />
          <Button
            size="m"
            disabled={passwordBusy || !currentPassword || newPassword.length < 8}
            onClick={() => void onChangePassword()}
          >
            {t('confirm')}
          </Button>
        </div>
        {passwordStatus ? <div className={styles.success}>{passwordStatus}</div> : null}
        {passwordError ? <div className={styles.error}>{passwordError}</div> : null}
      </div>

      <div className={styles.cell}>
        <div className={styles.text}>
          <div className={styles.label}>{t('authLogout')}</div>
        </div>
        <Button variant="dangerOutlined" size="m" onClick={() => setLogoutOpen(true)}>
          {t('authLogout')}
        </Button>
      </div>

      {logoutOpen ? (
        <Modal
          title={t('authLogoutConfirmTitle')}
          onClose={() => {
            if (!logoutBusy) {
              setLogoutOpen(false)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={logoutBusy} onClick={() => setLogoutOpen(false)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={logoutBusy}
                onClick={() => {
                  setLogoutBusy(true)
                  void logout()
                }}
              >
                {t('authLogout')}
              </Button>
            </>
          }
        >
          {t('authLogoutConfirmDescription')}
        </Modal>
      ) : null}
    </div>
  )
}
