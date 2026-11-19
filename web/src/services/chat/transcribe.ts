import { streamMessage } from '../api/client.js'
import type { MessageUsage } from '../api/types.js'
import { TRANSCRIBE_MODEL, TRANSCRIBE_PROMPT } from './reply.js'
import type { FileAttachment } from './types.js'

/** 一张图的转写上限；够写下截图里的大段文字，也防止异常时输出失控 */
const TRANSCRIBE_MAX_TOKENS = 4096

export type Transcription = { usage: MessageUsage; images: number }

export const EMPTY_USAGE: MessageUsage = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
}

export const addUsage = (a: MessageUsage, b: MessageUsage): MessageUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
})

/**
 * 用 deepseek-flash 把一张已上传的图片转写成文字（不思考、不联网）。
 * 没有转写出文字时返回空字符串，由调用方按「未能转写」处理。
 */
export const transcribeImage = async (
  file: FileAttachment,
  signal: AbortSignal
): Promise<{ text: string; usage: MessageUsage }> => {
  if (!file.serverId) {
    return { text: '', usage: EMPTY_USAGE }
  }
  let text = ''
  let usage = EMPTY_USAGE
  const events = streamMessage(
    {
      model: TRANSCRIBE_MODEL,
      system: '',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'file', file_id: file.serverId } },
            { type: 'text', text: TRANSCRIBE_PROMPT },
          ],
        },
      ],
      thinking: { type: 'disabled' },
      tools: [],
      max_tokens: TRANSCRIBE_MAX_TOKENS,
    },
    signal
  )
  for await (const event of events) {
    if (event.type === 'message_start' && event.message.usage) {
      usage = { ...EMPTY_USAGE, ...event.message.usage }
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    } else if (event.type === 'message_delta' && event.usage) {
      usage = { ...usage, ...event.usage }
    }
  }
  return { text: text.trim(), usage }
}
