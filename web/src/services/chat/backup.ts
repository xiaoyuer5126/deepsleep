import { formatDate } from '../../utils/format.js'
import * as db from './db.js'
import { applyRemoteSummaries, replaceHistory, useChatStore } from './store.js'
import type { Session } from './types.js'

export { BackupError } from './history/errors.js'

// 导入、导出与全部删除串行处理，避免读取归档时数据被清空或两个替换事务交错。
let backupQueue: Promise<unknown> = Promise.resolve()

const enqueueBackup = <T>(run: () => Promise<T>): Promise<T> => {
  const task = backupQueue.then(run)
  backupQueue = task.catch(() => {})
  return task
}

const backupFileName = (date: Date) => `deepseek_data-${formatDate(date)}.zip`

/** 单条对话导出文件名里的标题片段：去掉文件系统不支持的字符 */
const safeTitle = (title: string | undefined) => {
  const clean = (title ?? '')
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return clean || 'chat'
}

/** 导出为历史会话导出格式的 ZIP，可再次导入。 */
export const exportHistory = (): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    // 列表和已加载内容保留导出开始时的快照；未打开的会话逐条读取，不填满详情缓存。
    const { sessions, sessionCache } = useChatStore.getState()
    async function* readSessions(): AsyncGenerator<Session> {
      for (const summary of sessions) {
        const session = Object.hasOwn(sessionCache, summary.id)
          ? sessionCache[summary.id]
          : await db.loadSession(summary.id)
        if (!session) {
          throw new Error(`History session disappeared during export: ${summary.id}`)
        }
        // 详情读取期间可能重命名，归档标题与开始时的列表保持一致。
        yield { ...session, ...summary }
      }
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const blob = await exportArchive(readSessions())
    return { name: backupFileName(now), blob }
  })

/** 导出单条对话为 ZIP（分享给别人，或只备份这一条）。 */
export const exportSession = (id: string): Promise<{ name: string; blob: Blob }> =>
  enqueueBackup(async () => {
    const { sessions, sessionCache } = useChatStore.getState()
    const summary = sessions.find((session) => session.id === id)
    if (!summary) {
      throw new Error(`History session disappeared during export: ${id}`)
    }
    const session = Object.hasOwn(sessionCache, id)
      ? sessionCache[id]
      : await db.loadSession(id)
    if (!session) {
      throw new Error(`History session disappeared during export: ${id}`)
    }
    const { exportArchive } = await import('./history/exportArchive.js')
    const now = new Date()
    const target: Session = {
      ...session,
      id: summary.id,
      title: summary.title,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    }
    async function* readOne(): AsyncGenerator<Session> {
      yield target
    }
    const blob = await exportArchive(readOne())
    return {
      name: `deepseek_chat-${safeTitle(summary.title)}-${formatDate(now)}.zip`,
      blob,
    }
  })

/**
 * 导入历史对话。返回本次导入的会话数。
 * - replace：覆盖当前账号的全部对话（原行为）
 * - append：保留现有对话，把导入内容追加进来；id 冲突由服务端换新 id
 */
export const importHistory = (
  file: File,
  mode: 'replace' | 'append' = 'append'
): Promise<number> =>
  enqueueBackup(async () => {
    const { checkArchiveFormat, importArchive } = await import('./history/importArchive.js')
    await checkArchiveFormat(file)
    if (mode === 'replace') {
      return replaceHistory(() => importArchive(file))
    }
    const before = useChatStore.getState().sessions.length
    await db.clearStaging()
    try {
      await importArchive(file)
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history import'))
      throw error
    }
    const summaries = await db.commitStaging('append')
    applyRemoteSummaries(summaries)
    return Math.max(0, summaries.length - before)
  })

/** 确认删除后调用：以空历史原子替换全部本地会话与附件，保留 API Key 和其他设置。 */
export const clearHistory = (): Promise<void> =>
  enqueueBackup(async () => {
    await replaceHistory(async () => {})
  })
