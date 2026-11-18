import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { renameSession } from '../../services/chat/store.js'
import styles from './SessionTitle.module.css'

/**
 * 会话标题：点击即可就地重命名（与网页端一致）。
 * Enter / 失焦保存，Esc 取消；清空或未修改时不提交。
 */
export const SessionTitle = ({ id, title }: { id: string; title: string }) => {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(title)
  const display = title || t('untitledChat')

  if (editing) {
    const finish = (commit: boolean) => {
      setEditing(false)
      const next = value.trim()
      if (commit && next && next !== title) {
        renameSession(id, next)
      }
    }
    return (
      <input
        className={styles.input}
        value={value}
        autoFocus
        maxLength={200}
        placeholder={t('untitledChat')}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(true)
          } else if (event.key === 'Escape') {
            finish(false)
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className={styles.button}
      title={t('sessionTitleRenameTip')}
      onClick={() => {
        setValue(title)
        setEditing(true)
      }}
    >
      {display}
    </button>
  )
}
