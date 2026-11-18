import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt)

/** scrypt 参数：N=16384 是 Node 默认值，单次校验约几十毫秒。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url')

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex')

/** 生成密码哈希；返回 {hash, salt}，均为 hex。 */
export const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16).toString('hex')
  const derived = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  })
  return { hash: derived.toString('hex'), salt }
}

/** 恒定时间比较，避免通过响应时间猜测密码。 */
export const verifyPassword = async (password, salt, expectedHash) => {
  const derived = await scrypt(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  })
  const expected = Buffer.from(expectedHash, 'hex')
  if (expected.length !== derived.length) {
    return false
  }
  return crypto.timingSafeEqual(derived, expected)
}

/** 由 APP_SECRET 派生 AES-256-GCM 密钥。 */
const encryptionKey = (secret) => crypto.createHash('sha256').update(`api-key:${secret}`).digest()

/** 加密用户绑定的 API Key，返回 base64(iv|tag|ciphertext)。 */
export const encryptSecret = (plain, secret) => {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv)
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64')
}

export const decryptSecret = (payload, secret) => {
  const raw = Buffer.from(payload, 'base64')
  const iv = raw.subarray(0, 12)
  const tag = raw.subarray(12, 28)
  const data = raw.subarray(28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
}

/** 展示用的 Key 掩码，只保留前 3 位与后 4 位。 */
export const maskApiKey = (key) => {
  if (!key) {
    return ''
  }
  if (key.length <= 10) {
    return `${key.slice(0, 2)}****`
  }
  return `${key.slice(0, 3)}****${key.slice(-4)}`
}
