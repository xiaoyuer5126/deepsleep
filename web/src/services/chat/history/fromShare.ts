import type { TextCitation } from '../../api/types.js'
import type { ReplyBlock, Session } from '../types.js'
import { fail } from './errors.js'
import type { ChatMessage, Fragment, SessionFile } from './format.js'
import { imagePath } from './paths.js'
import { readSessionFile } from './schema.js'
import { toLocalSession } from './toLocal.js'

/**
 * DeepSeek 官网分享（/api/v0/share/content 的 biz_data）转本地会话。
 *
 * 分享与官网导出 ZIP 的消息结构基本一致，先转成归档格式（SessionFile），
 * 复用同一套校验和本地转换；区别在于：
 * - 时间是 Unix 秒，转 ISO；搜索查询词是 { query } 对象；打开网页的信息在 result 里；
 * - 回答里保留了 [reference:N] 角标，N 指向该回答 references 列表，转成本地文本块引用；
 * - 图片只有签名路径，原件由服务端代下（预览图），下载失败的只保留文件名；
 * - 标题固定为 "Shared Conversation"，用第一句提问代替；
 * - 可能只分享了后半段，第一条的父消息不在分享里，当作根。
 */

type Raw = Record<string, unknown>

const DEFAULT_SHARE_TITLE = 'Shared Conversation'
const TITLE_MAX_LENGTH = 40

const isRecord = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const records = (value: unknown): Raw[] => (Array.isArray(value) ? value.filter(isRecord) : [])

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const optionalText = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Unix 秒 → ISO；缺失或非法时为 null */
const isoTime = (value: unknown): string | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? new Date(Math.round(value * 1000)).toISOString()
    : null

const stageMetadata = (item: Raw) =>
  Number.isSafeInteger(item.stage_id) && (item.stage_id as number) >= 0
    ? { stage_id: item.stage_id as number }
    : {}

/** 分享里的图片：本地文件 ID → 签名路径 */
export type ShareImages = Map<string, string>

/** 分享片段 → 归档片段；没有对应展示的（提示条等）直接丢弃，字段不合法的交给校验丢弃 */
const toFragment = (item: Raw, sessionId: string, images: ShareImages): unknown => {
  switch (item.type) {
    case 'REQUEST':
    case 'RESPONSE':
    case 'TEMPLATE_RESPONSE':
      return { type: item.type, content: item.content }
    case 'THINK':
      return {
        type: 'THINK',
        content: item.content,
        elapsed_secs: typeof item.elapsed_secs === 'number' ? item.elapsed_secs : null,
      }
    case 'TOOL_SEARCH':
      return {
        type: 'TOOL_SEARCH',
        queries: (Array.isArray(item.queries) ? item.queries : [])
          .map((query) => (isRecord(query) ? query.query : query))
          .filter((query): query is string => typeof query === 'string'),
        results: records(item.results).map((result) => ({
          url: result.url,
          title: text(result.title),
          snippet: text(result.snippet),
          published_at: isoTime(result.published_at),
          site_name: optionalText(result.site_name),
          site_icon: optionalText(result.site_icon),
        })),
        ...(item.status === undefined ? {} : { status: item.status }),
        ...stageMetadata(item),
      }
    case 'TOOL_OPEN': {
      const result = isRecord(item.result) ? item.result : {}
      return {
        type: 'TOOL_OPEN',
        status: item.status,
        url: optionalText(result.url),
        title: optionalText(result.title),
        snippet: optionalText(result.snippet),
        site_name: optionalText(result.site_name),
        published_at: isoTime(result.published_at),
        ...stageMetadata(item),
      }
    }
    case 'TOOL_FIND':
      return {
        type: 'TOOL_FIND',
        status: item.status,
        ...(typeof item.pattern === 'string' ? { pattern: item.pattern } : {}),
        ...stageMetadata(item),
      }
    case 'FILE':
      return {
        type: 'FILE',
        files: records(item.files).map((file) => {
          const id = text(file.id).replace(/^file-/, '')
          const name = text(file.file_name) || 'file'
          const signedPath = optionalText(file.signed_path)
          const isImage = file.is_image === true
          const exportPath = isImage && id && signedPath ? imagePath(sessionId, id, name) : null
          if (exportPath && signedPath) {
            images.set(id, signedPath)
          }
          return {
            id,
            file_name: name,
            file_size: file.file_size,
            token_usage: Number.isSafeInteger(file.token_usage) ? file.token_usage : null,
            inserted_at: isoTime(file.inserted_at) ?? new Date(0).toISOString(),
            export_path: exportPath,
            is_image: isImage,
            width: Number.isSafeInteger(file.width) ? file.width : null,
            height: Number.isSafeInteger(file.height) ? file.height : null,
          }
        }),
      }
    default:
      return null
  }
}

/** 第一句提问的首行，截断到 40 字 */
const titleOf = (share: Raw, messages: Raw[]): string => {
  const own = text(share.title).trim()
  if (own && own !== DEFAULT_SHARE_TITLE) {
    return own.slice(0, TITLE_MAX_LENGTH)
  }
  for (const message of messages) {
    for (const item of records(message.fragments)) {
      const line = item.type === 'REQUEST' ? text(item.content).trim().split('\n')[0].trim() : ''
      if (line) {
        return [...line].length > TITLE_MAX_LENGTH
          ? `${[...line].slice(0, TITLE_MAX_LENGTH).join('')}…`
          : line
      }
    }
  }
  return ''
}

/** 每条回答消息里各 RESPONSE 片段的引用列表：references[N].urls */
type ResponseReferences = string[][][]

export type ShareConversion = {
  session: Session
  images: ShareImages
}

const REFERENCE_RUN = /(?:\[reference:\d+\])+/g

/**
 * 把一个回答文本块按 [reference:N] 拆成多块：角标所在处为块尾，引用挂在该块上。
 * 与流式回答一致（挂过引用的块之后另起新块），展示时在块尾插入可点的角标。
 * 找不到对应网址的角标直接去掉。
 */
export const splitReferences = (
  value: string,
  references: string[][],
  titles: ReadonlyMap<string, string>
): ReplyBlock[] => {
  const blocks: ReplyBlock[] = []
  let pending = ''
  let last = 0
  for (const match of value.matchAll(REFERENCE_RUN)) {
    pending += value.slice(last, match.index)
    last = match.index + match[0].length
    const urls = new Set<string>()
    for (const [, index] of match[0].matchAll(/\[reference:(\d+)\]/g)) {
      for (const url of references[Number(index)] ?? []) {
        urls.add(url)
      }
    }
    if (urls.size === 0) {
      continue
    }
    const citedText = pending.trim()
    const citations: TextCitation[] = [...urls].map((url) => ({
      type: 'web_search_result_location',
      url,
      title: titles.get(url) ?? null,
      cited_text: citedText,
      encrypted_index: '',
    }))
    blocks.push({ type: 'text', text: pending, citations })
    pending = ''
  }
  pending += value.slice(last)
  if (pending || blocks.length === 0) {
    blocks.push({ type: 'text', text: pending })
  }
  return blocks
}

const isWebUrl = (value: string) => {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/** 网址 → 标题，取自同一回答的搜索结果与打开的网页 */
const titlesOf = (fragments: Fragment[]): Map<string, string> => {
  const titles = new Map<string, string>()
  for (const item of fragments) {
    if (item.type === 'TOOL_SEARCH') {
      for (const result of item.results) {
        if (result.title && !titles.has(result.url)) {
          titles.set(result.url, result.title)
        }
      }
    } else if (item.type === 'TOOL_OPEN' && item.url && item.title && !titles.has(item.url)) {
      titles.set(item.url, item.title)
    }
  }
  return titles
}

export const fromShare = (value: unknown, sessionId: string): ShareConversion => {
  const share = isRecord(value) ? value : fail('shareImportInvalid')
  const messages = records(share.messages)
  if (messages.length === 0) {
    fail('shareImportEmpty')
  }
  const images: ShareImages = new Map()
  const references = new Map<number, ResponseReferences>()

  // 只分享了后半段对话时，第一条消息的父消息不在分享里，把它当作根
  const present = new Set(messages.map((message) => message.message_id))
  const archived = messages.map((message) => {
    const id = message.message_id
    const fragments = records(message.fragments)
    if (typeof id === 'number') {
      references.set(
        id,
        fragments
          .filter((item) => item.type === 'RESPONSE')
          .map((item) =>
            records(item.references).map((reference) =>
              (Array.isArray(reference.urls) ? reference.urls : []).filter(
                (url): url is string => typeof url === 'string' && isWebUrl(url)
              )
            )
          )
      )
    }
    return {
      id,
      parent_id: present.has(message.parent_id) ? message.parent_id : null,
      role: message.role,
      status: message.status,
      thinking_enabled: message.thinking_enabled === true,
      search_enabled: message.search_enabled === true,
      accumulated_token_usage: Number.isSafeInteger(message.accumulated_token_usage)
        ? Math.max(0, message.accumulated_token_usage as number)
        : 0,
      inserted_at: isoTime(message.inserted_at) ?? new Date(0).toISOString(),
      fragments: fragments
        .map((item) => toFragment(item, sessionId, images))
        .filter((item) => item !== null),
    }
  })

  const ids = archived.map((message) => message.id).filter((id) => typeof id === 'number')
  const times = archived.map((message) => message.inserted_at).toSorted()
  const file: SessionFile = readSessionFile({
    id: sessionId,
    title: titleOf(share, messages) || null,
    pinned: false,
    // 分享是单线对话，停在最后一条
    current_message_id: Math.max(...ids),
    inserted_at: times[0],
    updated_at: times.at(-1),
    messages: archived,
  })

  const { session } = toLocalSession(file)
  const byId = new Map<string, ChatMessage>(file.messages.map((item) => [String(item.id), item]))
  session.messages = session.messages.map((message) => {
    const source = byId.get(message.id)
    const responseReferences = references.get(Number(message.id))
    if (message.role !== 'assistant' || !source || !responseReferences) {
      return message
    }
    const titles = titlesOf(source.fragments)
    // 本地正文块与 RESPONSE 片段一一对应、顺序相同（模板块单独标记）
    let response = 0
    return {
      ...message,
      blocks: message.blocks.flatMap((block) =>
        block.type === 'text' && !block.isTemplate
          ? splitReferences(block.text, responseReferences[response++] ?? [], titles)
          : [block]
      ),
    }
  })
  return { session, images }
}
