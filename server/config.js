import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_PRICING } from './pricing.js'

/** 读取布尔型环境变量，接受 1/true/yes/on。 */
const bool = (value, fallback = false) => {
  if (value === undefined || value === '') {
    return fallback
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

const int = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const parsePricing = () => {
  const raw = process.env.PRICING_JSON?.trim()
  if (!raw) {
    return DEFAULT_PRICING
  }
  try {
    return { ...DEFAULT_PRICING, ...JSON.parse(raw) }
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[config] PRICING_JSON 不是合法 JSON，使用默认价格')
    return DEFAULT_PRICING
  }
}

/**
 * APP_SECRET 用于加密用户绑定的 API Key、派生 Cookie 签名密钥。
 * 未显式配置时生成一次并写入数据目录，保证容器重启后仍能解密。
 */
const loadSecret = (dataDir) => {
  const fromEnv = process.env.APP_SECRET?.trim()
  if (fromEnv) {
    return fromEnv
  }
  const file = path.join(dataDir, 'app-secret')
  try {
    const saved = fs.readFileSync(file, 'utf8').trim()
    if (saved) {
      return saved
    }
  } catch {
    // 首次启动，下面生成
  }
  const generated = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, generated, { mode: 0o600 })
  // eslint-disable-next-line no-console
  console.warn(
    `[config] APP_SECRET 未设置，已生成随机密钥并保存到 ${file}。生产环境建议通过环境变量显式配置。`
  )
  return generated
}

export const loadConfig = (overrides = {}) => {
  const root = path.resolve(overrides.rootDir ?? process.cwd())
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.DATA_DIR ?? path.join(root, 'data')
  )
  const webDist = path.resolve(
    overrides.webDist ?? process.env.WEB_DIST ?? path.join(root, 'web', 'dist')
  )
  const config = {
    root,
    dataDir,
    webDist,
    // 服务监听端口；前端与 API 同源，Docker 内默认 3080
    port: int(overrides.port ?? process.env.PORT, 3080),
    host: overrides.host ?? process.env.HOST ?? '0.0.0.0',
    // 上游 DeepSeek API 地址；测试时指向本地 mock
    apiBase: (
      overrides.apiBase ??
      process.env.DEEPSEEK_API_BASE ??
      'https://api.deepseek.com'
    ).replace(/\/+$/, ''),
    // 服务器默认 API Key：账号未绑定自己的 Key 时使用。
    // 适合“一个人付费、几个人共用”的场景；留空则要求每个账号自行绑定。
    defaultApiKey: (overrides.defaultApiKey ?? process.env.DEFAULT_DEEPSEEK_API_KEY ?? '').trim(),
    // 开放注册；关闭后只能由已有账号在“账号”页创建？——不提供，直接关闭注册。
    allowRegistration: bool(overrides.allowRegistration ?? process.env.ALLOW_REGISTRATION, true),
    // 注册邀请码；非空时注册必须填写
    registerInviteCode: String(
      overrides.registerInviteCode ?? process.env.REGISTER_INVITE_CODE ?? ''
    ).trim(),
    // 登录态有效期（天）
    sessionDays: int(overrides.sessionDays ?? process.env.SESSION_DAYS, 30),
    // 反向代理终止 TLS 时置 1，让 Cookie 带上 Secure
    cookieSecure: bool(process.env.COOKIE_SECURE, false),
    trustProxy: bool(process.env.TRUST_PROXY, false),
    // 单条会话 JSON、单个附件的上限
    maxJsonBytes: int(process.env.MAX_JSON_BYTES, 48 * 1024 * 1024),
    maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 96 * 1024 * 1024),
    logLevel: process.env.LOG_LEVEL ?? 'info',
    pricing: parsePricing(),
  }
  config.secret = overrides.secret ?? loadSecret(dataDir)
  return config
}

export const publicConfig = (config) => ({
  allowRegistration: config.allowRegistration,
  requireInviteCode: config.registerInviteCode.length > 0,
  hasDefaultApiKey: Boolean(config.defaultApiKey),
  sessionDays: config.sessionDays,
  pricing: config.pricing,
})
