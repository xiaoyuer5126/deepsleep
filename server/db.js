import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DEFAULT_PRICING, summarizeSessionUsage } from './pricing.js'

/**
 * SQLite（Node 内置 node:sqlite）数据层。
 * 所有查询都是同步的：单进程下天然串行，导入替换用事务保证原子性。
 * 附件原件以 BLOB 存放在 files / staging_files 表，便于和会话一起做原子替换与备份。
 */

const now = () => Date.now()

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  api_key_cipher TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username));

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions (user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  usage TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_files (
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, file_id)
);

CREATE TABLE IF NOT EXISTS files (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS staging_sessions (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS staging_files (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (user_id, id)
);
`

const fail = (message, status = 400) => {
  const error = new Error(message)
  error.status = status
  return error
}

/** 结构化校验会话对象，避免把前端损坏的数据写进库。 */
export const sanitizeSession = (value, expectedId) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw fail('会话数据格式不正确')
  }
  if (typeof value.id !== 'string' || !value.id || value.id.length > 128) {
    throw fail('会话 id 不合法')
  }
  if (expectedId && value.id !== expectedId) {
    throw fail('会话 id 与路径不一致')
  }
  const session = {
    id: value.id,
    title: typeof value.title === 'string' ? value.title.slice(0, 500) : '',
    createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now(),
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : now(),
    messages: Array.isArray(value.messages) ? value.messages : [],
  }
  if (Object.hasOwn(value, 'rootMessageId')) {
    session.rootMessageId = value.rootMessageId
  }
  if (session.messages.length > 20000) {
    throw fail('单条会话消息过多')
  }
  return session
}

/** 会话中引用到的本地附件 id（用户消息里的 files）。 */
const referencedFileIds = (session) => {
  const ids = new Set()
  for (const message of session.messages) {
    if (!message || message.role !== 'user' || !Array.isArray(message.files)) {
      continue
    }
    for (const file of message.files) {
      if (file && typeof file.id === 'string' && file.id) {
        ids.add(file.id)
      }
    }
  }
  return ids
}

export const openDatabase = (dataDir, { sessionDays = 30, pricing = DEFAULT_PRICING } = {}) => {
  fs.mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(path.join(dataDir, 'app.db'))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  // 旧版本升级：补齐新增列（会话置顶、会话用量汇总）
  ensureColumn(db, 'conversations', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'conversations', 'usage', 'TEXT')
  return new Store(db, { sessionDays, pricing })
}

const ensureColumn = (db, table, column, definition) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all()
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
}

export class Store {
  constructor(db, { sessionDays = 30, pricing = DEFAULT_PRICING } = {}) {
    this.db = db
    this.sessionDays = sessionDays
    this.pricing = pricing
  }

  /** 用量按「高峰 / 空闲」分桶汇总，前端用当前单价换算成金额 */
  usageOf(messages) {
    return summarizeSessionUsage(messages, this.pricing.peakWindows)
  }

  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // 事务可能已经因错误自动回滚
      }
      throw error
    }
  }

  /** 用户 */

  createUser({ username, passwordHash, passwordSalt }) {
    const id = crypto.randomUUID()
    const createdAt = now()
    this.db
      .prepare(
        'INSERT INTO users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(id, username, passwordHash, passwordSalt, createdAt)
    return this.findUserById(id)
  }

  findUserByUsername(username) {
    return this.db
      .prepare('SELECT * FROM users WHERE lower(username) = lower(?)')
      .get(String(username ?? '').trim())
  }

  findUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id)
  }

  countUsers() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  }

  touchLogin(userId) {
    this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now(), userId)
  }

  setUserApiKey(userId, cipher) {
    this.db.prepare('UPDATE users SET api_key_cipher = ? WHERE id = ?').run(cipher, userId)
  }

  updateUserPassword(userId, passwordHash, passwordSalt) {
    this.db
      .prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .run(passwordHash, passwordSalt, userId)
  }

  /** 登录态 */

  createAuthSession({ tokenHash, userId, userAgent }) {
    const createdAt = now()
    const expiresAt = createdAt + this.sessionDays * 24 * 60 * 60 * 1000
    this.db
      .prepare(
        'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
      )
      .run(tokenHash, userId, createdAt, expiresAt, userAgent ?? null)
    return { createdAt, expiresAt }
  }

  findAuthSession(tokenHash) {
    return this.db
      .prepare(
        'SELECT * FROM auth_sessions WHERE token_hash = ? AND expires_at > ?'
      )
      .get(tokenHash, now())
  }

  deleteAuthSession(tokenHash) {
    this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash)
  }

  deleteOtherAuthSessions(userId, keepTokenHash) {
    this.db
      .prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash <> ?')
      .run(userId, keepTokenHash)
  }

  deleteExpiredAuthSessions() {
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now())
  }

  setSessionDays(days) {
    this.sessionDays = days
  }

  /** 会话 */

  /** 列表：置顶优先，其次按更新时间倒序；附带用量汇总供侧边栏显示费用 */
  listSessions(userId) {
    return this.db
      .prepare(
        `SELECT id, title, created_at AS createdAt, updated_at AS updatedAt, pinned, usage
         FROM conversations
         WHERE user_id = ?
         ORDER BY pinned DESC, updated_at DESC`
      )
      .all(userId)
      .map((row) => this.toSummary(row))
  }

  toSummary(row) {
    let usage = null
    if (row.usage) {
      try {
        usage = JSON.parse(row.usage)
      } catch {
        usage = null
      }
    }
    return {
      id: row.id,
      title: row.title,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      pinned: Boolean(row.pinned),
      usage,
    }
  }

  getSession(userId, id) {
    const row = this.db
      .prepare('SELECT data FROM conversations WHERE user_id = ? AND id = ?')
      .get(userId, id)
    return row ? row.data : null
  }

  saveSession(userId, session) {
    const data = JSON.stringify(session)
    const usage = JSON.stringify(this.usageOf(session.messages))
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO conversations (id, user_id, title, created_at, updated_at, data, usage)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             title = excluded.title,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             data = excluded.data,
             usage = excluded.usage
           WHERE conversations.user_id = excluded.user_id`
        )
        .run(session.id, userId, session.title, session.createdAt, session.updatedAt, data, usage)
      this.replaceSessionReferences(userId, session)
    })
    this.gcFiles(userId)
    return session
  }

  replaceSessionReferences(userId, session) {
    this.db
      .prepare('DELETE FROM conversation_files WHERE conversation_id = ?')
      .run(session.id)
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO conversation_files (user_id, conversation_id, file_id) VALUES (?, ?, ?)'
    )
    for (const fileId of referencedFileIds(session)) {
      insert.run(userId, session.id, fileId)
    }
  }

  renameSession(userId, id, title) {
    const clean = String(title ?? '').slice(0, 500)
    this.transaction(() => {
      const row = this.db
        .prepare('SELECT data FROM conversations WHERE user_id = ? AND id = ?')
        .get(userId, id)
      if (!row) {
        throw fail('会话不存在', 404)
      }
      let session
      try {
        session = JSON.parse(row.data)
      } catch {
        session = null
      }
      if (session && typeof session === 'object') {
        session.title = clean
        this.db
          .prepare('UPDATE conversations SET title = ?, data = ? WHERE user_id = ? AND id = ?')
          .run(clean, JSON.stringify(session), userId, id)
      } else {
        this.db
          .prepare('UPDATE conversations SET title = ? WHERE user_id = ? AND id = ?')
          .run(clean, userId, id)
      }
    })
  }

  /** 置顶 / 取消置顶 */
  setPinned(userId, id, pinned) {
    const result = this.db
      .prepare('UPDATE conversations SET pinned = ? WHERE user_id = ? AND id = ?')
      .run(pinned ? 1 : 0, userId, id)
    if (result.changes === 0) {
      throw fail('会话不存在', 404)
    }
  }

  /** 账号下全部会话的用量合计（用于「账号」页显示累计花费） */
  getUserUsage(userId) {
    const empty = () => ({ inputMiss: 0, cacheHit: 0, output: 0, searches: 0 })
    const total = { peak: empty(), offPeak: empty(), pro: { peak: empty(), offPeak: empty() } }
    const add = (target, bucket) => {
      if (!bucket) {
        return
      }
      target.inputMiss += bucket.inputMiss ?? 0
      target.cacheHit += bucket.cacheHit ?? 0
      target.output += bucket.output ?? 0
      target.searches += bucket.searches ?? 0
    }
    const rows = this.db
      .prepare('SELECT usage FROM conversations WHERE user_id = ?')
      .all(userId)
    for (const row of rows) {
      if (!row.usage) {
        continue
      }
      let usage
      try {
        usage = JSON.parse(row.usage)
      } catch {
        continue
      }
      for (const key of ['peak', 'offPeak']) {
        add(total[key], usage?.[key])
        add(total.pro[key], usage?.pro?.[key])
      }
    }
    return total
  }

  deleteSession(userId, id) {
    this.transaction(() => {
      this.db
        .prepare('DELETE FROM conversations WHERE user_id = ? AND id = ?')
        .run(userId, id)
      this.db
        .prepare('DELETE FROM conversation_files WHERE user_id = ? AND conversation_id = ?')
        .run(userId, id)
    })
    this.gcFiles(userId)
  }

  /** 附件原件 */

  putFile(userId, id, mime, data, staged = false) {
    const table = staged ? 'staging_files' : 'files'
    this.db
      .prepare(
        `INSERT INTO ${table} (user_id, id, mime, size, created_at, data)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, id) DO UPDATE SET
           mime = excluded.mime,
           size = excluded.size,
           data = excluded.data`
      )
      .run(userId, id, String(mime ?? ''), data.byteLength, now(), data)
  }

  getFile(userId, id) {
    return this.db
      .prepare('SELECT id, mime, size, data FROM files WHERE user_id = ? AND id = ?')
      .get(userId, id)
  }

  getFileMeta(userId, id) {
    return this.db
      .prepare('SELECT id, mime, size FROM files WHERE user_id = ? AND id = ?')
      .get(userId, id)
  }

  /** 清理不再被任何会话引用的原件（导入暂存保留）。 */
  gcFiles(userId) {
    this.db
      .prepare(
        `DELETE FROM files
         WHERE user_id = ?
           AND id NOT IN (SELECT file_id FROM conversation_files WHERE user_id = ?)`
      )
      .run(userId, userId)
  }

  /** 历史导入：暂存 → 原子替换 */

  resetStaging(userId) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM staging_sessions WHERE user_id = ?').run(userId)
      this.db.prepare('DELETE FROM staging_files WHERE user_id = ?').run(userId)
    })
  }

  putStagingSession(userId, session) {
    this.db
      .prepare(
        `INSERT INTO staging_sessions (user_id, id, data) VALUES (?, ?, ?)
         ON CONFLICT (user_id, id) DO UPDATE SET data = excluded.data`
      )
      .run(userId, session.id, JSON.stringify(session))
  }

  /** 归档里的图片在会话 JSON 之后到达，回填 MIME 以支持跨端展示。 */
  updateStagingFileTypes(userId, types) {
    this.transaction(() => {
      const rows = this.db
        .prepare('SELECT id, data FROM staging_sessions WHERE user_id = ?')
        .all(userId)
      const update = this.db.prepare(
        'UPDATE staging_sessions SET data = ? WHERE user_id = ? AND id = ?'
      )
      for (const row of rows) {
        let session
        try {
          session = JSON.parse(row.data)
        } catch {
          continue
        }
        let changed = false
        for (const message of session.messages ?? []) {
          if (!message || message.role !== 'user' || !Array.isArray(message.files)) {
            continue
          }
          for (const file of message.files) {
            if (!file || typeof file.id !== 'string') {
              continue
            }
            const mime = types[file.id] ?? ''
            if (file.mimeType !== mime) {
              file.mimeType = mime
              changed = true
            }
          }
        }
        if (changed) {
          update.run(JSON.stringify(session), userId, session.id ?? row.id)
        }
      }
    })
  }

  /**
   * 提交暂存区。
   * - mode = 'replace'：用暂存内容替换该账号的全部会话与原件（默认，原子操作）
   * - mode = 'append'：保留现有会话，把暂存内容追加进来；id 冲突时生成新 id，不覆盖已有对话
   * 返回提交后的完整会话列表（含置顶、用量）。
   */
  commitStaging(userId, mode = 'replace') {
    this.transaction(() => {
      const staged = this.db
        .prepare('SELECT id, data FROM staging_sessions WHERE user_id = ?')
        .all(userId)
      const parsed = staged.map((row) => sanitizeSession(JSON.parse(row.data)))

      if (mode === 'replace') {
        this.db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId)
        this.db.prepare('DELETE FROM conversation_files WHERE user_id = ?').run(userId)
        this.db.prepare('DELETE FROM files WHERE user_id = ?').run(userId)
      }

      const insertSession = this.db.prepare(
        `INSERT INTO conversations (id, user_id, title, created_at, updated_at, data, usage)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      const exists = this.db.prepare(
        'SELECT 1 AS found FROM conversations WHERE user_id = ? AND id = ?'
      )
      // 追加模式：同一份归档重复导入时，换新 id 而不是覆盖或报错
      for (const session of parsed) {
        let stored = session
        if (mode === 'append' && exists.get(userId, session.id)) {
          stored = { ...session, id: crypto.randomUUID() }
        }
        insertSession.run(
          stored.id,
          userId,
          stored.title,
          stored.createdAt,
          stored.updatedAt,
          JSON.stringify(stored),
          JSON.stringify(this.usageOf(stored.messages))
        )
        this.replaceSessionReferences(userId, stored)
      }

      // 附件原件：替换模式直接搬入；追加模式保留已有原件（同 id 内容相同，忽略冲突）
      const fileOp = mode === 'replace' ? 'INSERT INTO' : 'INSERT OR IGNORE INTO'
      this.db
        .prepare(
          `${fileOp} files (user_id, id, mime, size, created_at, data)
           SELECT user_id, id, mime, size, created_at, data FROM staging_files WHERE user_id = ?`
        )
        .run(userId)
      this.db.prepare('DELETE FROM staging_sessions WHERE user_id = ?').run(userId)
      this.db.prepare('DELETE FROM staging_files WHERE user_id = ?').run(userId)
    })
    this.gcFiles(userId)
    return this.listSessions(userId)
  }

  /** 测试与运维用：彻底删除用户及其数据。 */
  deleteUser(userId) {
    this.transaction(() => {
      for (const table of [
        'conversation_files',
        'conversations',
        'files',
        'staging_sessions',
        'staging_files',
        'auth_sessions',
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId)
      }
      this.db.prepare('DELETE FROM users WHERE id = ?').run(userId)
    })
  }

  close() {
    this.db.close()
  }
}
