// 运行：pnpm test（Node 24 直接执行 TypeScript，无需构建）
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getImagesToTranscribe,
  supportsVision,
  toRequestMessages,
  transcribedImageText,
} from '../src/services/chat/reply.ts'
import type { AssistantMessage, FileAttachment, UserMessage } from '../src/services/chat/types.ts'

const image = (id: string, extra: Partial<FileAttachment> = {}): FileAttachment => ({
  id,
  serverId: `file-${id}`,
  name: `${id}.png`,
  size: 1,
  isImage: true,
  mimeType: 'image/png',
  ...extra,
})

const pdf: FileAttachment = {
  id: 'doc',
  serverId: 'file-doc',
  name: 'a.pdf',
  size: 1,
  isImage: false,
  mimeType: 'application/pdf',
}

const user = (id: string, content: string, files: FileAttachment[] = []): UserMessage => ({
  id,
  role: 'user',
  content,
  files,
  createdAt: 0,
})

const answer = (id: string, text: string): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 0,
  model: 'deepseek-flash',
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text }],
})

test('只有 deepseek-v4-pro 不能看图', () => {
  assert.equal(supportsVision('deepseek-flash'), true)
  assert.equal(supportsVision(null), true)
  assert.equal(supportsVision('deepseek-v4-pro'), false)
})

test('flash 请求照旧按 file_id 发图片和文档', () => {
  const messages = toRequestMessages(
    [],
    user('q', '看图', [image('a'), pdf]),
    undefined,
    false,
    undefined,
    'deepseek-flash'
  )
  assert.deepEqual(messages.at(-1), {
    role: 'user',
    content: [
      { type: 'image', source: { type: 'file', file_id: 'file-a' } },
      { type: 'document', source: { type: 'file', file_id: 'file-doc' } },
      { type: 'text', text: '看图' },
    ],
  })
})

test('pro 请求里图片换成转写文字，文档照旧，历史图片也换', () => {
  const history = [
    user('u1', '第一张', [image('old', { transcript: '一只猫' })]),
    answer('a1', '好'),
  ]
  const question = user('q', '这两张图有什么区别', [image('new', { transcript: '一只狗' }), pdf])
  const messages = toRequestMessages(
    history,
    question,
    undefined,
    false,
    undefined,
    'deepseek-v4-pro'
  )
  assert.deepEqual(messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: transcribedImageText('old.png', '一只猫') },
      { type: 'text', text: '第一张' },
    ],
  })
  assert.deepEqual(messages.at(-1), {
    role: 'user',
    content: [
      { type: 'text', text: transcribedImageText('new.png', '一只狗') },
      { type: 'document', source: { type: 'file', file_id: 'file-doc' } },
      { type: 'text', text: '这两张图有什么区别' },
    ],
  })
  const json = JSON.stringify(messages)
  assert.ok(!json.includes('"image"'), 'pro 请求里不能出现 image 块')
  assert.ok(json.includes('一只猫') && json.includes('一只狗'))
})

test('pro 请求里没转写成功的图片写明看不到', () => {
  const messages = toRequestMessages(
    [],
    user('q', '这是什么', [image('x')]),
    undefined,
    false,
    undefined,
    'deepseek-v4-pro'
  )
  const content = messages.at(-1)?.content
  assert.ok(Array.isArray(content))
  assert.equal(content[0].type, 'text')
  assert.match((content[0] as { text: string }).text, /未能转写/)
})

test('要转写的图片：本轮和进入上下文的历史里、已上传且没转写过的，同一附件只算一次', () => {
  const shared = image('shared')
  const history = [
    user('u1', '旧图', [shared, image('done', { transcript: '已有' })]),
    answer('a1', '好'),
    // 没有回答的轮次不进上下文
    user('u2', '失败的', [image('orphan')]),
  ]
  const question = user('q', '再看', [shared, image('local', { serverId: null }), pdf])
  const files = getImagesToTranscribe(history, question)
  assert.deepEqual(
    files.map((file) => file.id),
    ['shared']
  )
})
