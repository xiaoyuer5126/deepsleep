import { BackendError, requestBackend, requestJson } from '../api/backend.js'
import type { Session, SessionSummary } from './types.js'

/**
 * 会话与附件的持久化：数据存在自建后端（SQLite），同一账号在多端登录后看到同一份历史。
 *
 * 与原 demo 的 IndexedDB 实现保持相同的函数签名，上层会话逻辑无需感知存储位置。
 * 附件原件（图片等）也上传到后端，换设备后仍能预览、重新上传给模型。
 */

export type StoredFile = {
  id: string
  blob: Blob
}

/** 已下载的原件缓存：同一附件在列表里会多次读取，避免重复请求。 */
const fileCache = new Map<string, Blob>()

/** 已成功存到服务器的原件 id，避免「选中时预上传」和「发送时保存会话」重复上传。 */
const storedIds = new Set<string>()

/**
 * 非图片原件的额外存一份的大小上限。历史消息里已经有 DeepSeek 的 file_id，
 * 跨设备只影响「打开原件」，不影响提问；大文件（常见 PDF/PPT）跳过可省一半隧道流量。
 */
const MAX_NON_IMAGE_STORE_BYTES = 8 * 1024 * 1024

const shouldStore = (file: StoredFile) =>
  file.blob.type.startsWith('image/') || file.blob.size <= MAX_NON_IMAGE_STORE_BYTES

export const loadSessionSummaries = async (): Promise<SessionSummary[]> => {
  const data = await requestJson<{ sessions: SessionSummary[] }>('/api/sessions')
  return data.sessions
}

export const loadSession = async (id: string): Promise<Session | undefined> => {
  try {
    const data = await requestJson<{ session: Session }>(`/api/sessions/${encodeURIComponent(id)}`)
    return data.session
  } catch (error) {
    if (error instanceof BackendError && error.status === 404) {
      return undefined
    }
    throw error
  }
}

const uploadFile = async (file: StoredFile): Promise<void> => {
  const mime = file.blob.type
  await requestBackend(
    `/api/files/${encodeURIComponent(file.id)}?mime=${encodeURIComponent(mime)}`,
    {
      method: 'PUT',
      body: file.blob,
      headers: { 'Content-Type': mime || 'application/octet-stream' },
    }
  )
  storedIds.add(file.id)
  fileCache.set(file.id, file.blob)
}

export const saveFiles = async (files: StoredFile[]): Promise<void> => {
  // 已存过、或超过上限的非图片原件直接跳过；图片始终存一份用于跨设备预览
  const pending = files.filter((file) => !storedIds.has(file.id) && shouldStore(file))
  if (pending.length === 0) {
    return
  }
  // 同时最多 3 个上传，避免一次选中很多附件时打满连接
  const queue = [...pending]
  const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      await uploadFile(file)
    }
  })
  await Promise.all(workers)
}

export const saveSession = async (
  session: Session,
  files: StoredFile[] = []
): Promise<SessionSummary | undefined> => {
  if (files.length > 0) {
    await saveFiles(files)
  }
  const data = await requestJson<{ session: SessionSummary }>(
    `/api/sessions/${encodeURIComponent(session.id)}`,
    { method: 'PUT', json: { session } }
  )
  return data.session
}

export const renameSession = async (id: string, title: string): Promise<void> => {
  await requestBackend(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: { title },
  })
}

/** 置顶 / 取消置顶 */
export const setPinned = async (id: string, pinned: boolean): Promise<void> => {
  await requestBackend(`/api/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: { pinned },
  })
}

export const deleteSession = async (sessionId: string): Promise<void> => {
  await requestBackend(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
  fileCache.clear()
}

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const cached = fileCache.get(id)
  if (cached) {
    return cached
  }
  try {
    const response = await requestBackend(`/api/files/${encodeURIComponent(id)}`)
    const blob = await response.blob()
    fileCache.set(id, blob)
    return blob
  } catch (error) {
    if (error instanceof BackendError && error.status === 404) {
      return undefined
    }
    throw error
  }
}

/**
 * 历史导入的暂存接口：导入过程中只写暂存区，全部成功后由后端在一个事务里替换，
 * 任何一步失败都只清空暂存，原有会话不受影响。
 */
export const clearStaging = async (): Promise<void> => {
  await requestBackend('/api/import/reset', { method: 'POST' })
}

export const addStagingSession = async (session: Session): Promise<void> => {
  await requestBackend(`/api/import/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PUT',
    json: { session },
  })
}

const saveImportedFiles = async (files: StoredFile[]): Promise<void> => {
  for (const file of files) {
    const mime = file.blob.type
    await requestBackend(
      `/api/import/files/${encodeURIComponent(file.id)}?mime=${encodeURIComponent(mime)}`,
      {
        method: 'PUT',
        body: file.blob,
        headers: { 'Content-Type': mime || 'application/octet-stream' },
      }
    )
  }
}

export const saveStagingFiles = saveImportedFiles

export const updateStagingFileTypes = async (
  types: ReadonlyMap<string, string>
): Promise<void> => {
  await requestBackend('/api/import/file-types', {
    method: 'POST',
    json: { types: Object.fromEntries(types) },
  })
}

export const commitStaging = async (
  mode: 'replace' | 'append' = 'replace'
): Promise<SessionSummary[]> => {
  const data = await requestJson<{ sessions: SessionSummary[] }>('/api/import/commit', {
    method: 'POST',
    json: { mode },
  })
  return data.sessions
}

/** 存储失败不打断对话，只在控制台留痕 */
export const reportStorageError = (action: string) => (error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(`[storage] ${action} failed`, error)
}
