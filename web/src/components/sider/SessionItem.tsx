import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconDownloadOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { exportSession } from '../../services/chat/backup.js'
import { pinSession, renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { estimateSessionCost, formatCost } from '../../services/pricing.js'
import { downloadBlob } from '../../utils/download.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

/** 置顶图标：实心表示已置顶 */
const PinIcon = ({ filled }: { filled: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M6.2 2.2h3.6l-.5 2.9 1.9 1.6v1.1H4.8V5.9l1.9-1.6-.5-2.1Z"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
    <path d="M8 7.8v4.9" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
)

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')
  const cost = estimateSessionCost(session.usage)
  const pinned = Boolean(session.pinned)

  const onExport = async () => {
    try {
      const { name, blob } = await exportSession(session.id)
      downloadBlob(name, blob)
    } catch {
      showToast({ key: 'sessionExportFailed', type: 'error' })
    }
  }

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active)}
      onClick={() => {
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.main}>
        <div className={styles.titleRow}>
          {pinned ? (
            <span className={styles.pin} title={t('sessionItemMenuUnpinOption')}>
              <PinIcon filled />
            </span>
          ) : null}
          <div className={styles.title}>{displayTitle}</div>
        </div>
        {cost > 0 ? (
          <div className={styles.cost}>{t('messageCostLabel', { cost: formatCost(cost) })}</div>
        ) : null}
      </div>
      <div className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'pin',
              label: t(pinned ? 'sessionItemMenuUnpinOption' : 'sessionItemMenuPinOption'),
              icon: <PinIcon filled={pinned} />,
              onSelect: () => pinSession(session.id, !pinned),
            },
            {
              key: 'export',
              label: t('sessionItemMenuExportOption'),
              icon: <IconDownloadOutline16 />,
              onSelect: () => void onExport(),
            },
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
    </div>
  )
})
