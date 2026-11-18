/**
 * 浏览器端冒烟测试（容器内 headless Chromium）。
 *
 * 构建与运行：
 *   docker build -t dsw-e2e tools/e2e
 *   docker compose -f docker-compose.test.yml up -d --build
 *   docker run --rm --network dpsk-self_default \
 *     -e TARGET_URL=http://deepseek-web-test:3080 \
 *     -v "$PWD/docs/screenshots:/shots" dsw-e2e
 */
import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const TARGET = process.env.TARGET_URL ?? 'http://web:3080'
const SHOTS = process.env.SHOTS_DIR ?? '/shots'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium'
const TITLE = '测试会话标题'

fs.mkdirSync(SHOTS, { recursive: true })

const results = []
const failures = []
const check = (name, ok, detail = '') => {
  results.push(`${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) {
    failures.push(name)
  }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=zh-CN'],
})

const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(String(error)))
page.on('console', (message) => {
  if (message.type() === 'error') {
    pageErrors.push(message.text())
  }
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shot = (name) => page.screenshot({ path: `${SHOTS}/${name}.png` })
const bodyText = () => page.evaluate(() => document.body.innerText)

const waitFor = async (predicate, timeout = 20000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (await predicate()) {
      return true
    }
    await sleep(200)
  }
  return false
}
const waitForText = (text, timeout = 20000) =>
  waitFor(async () => (await bodyText()).includes(text), timeout)

/** 找到可点击元素并点击；从后往前找，避免点到被弹窗遮住的同名按钮 */
const clickText = async (text) => {
  const clicked = await page.evaluate((needle) => {
    const elements = [
      ...document.querySelectorAll('button, a, [role="tab"], [role="button"], [role="menuitem"]'),
    ].reverse()
    const match = elements.find((element) => element.textContent?.trim().includes(needle))
    if (match) {
      match.click()
      return true
    }
    return false
  }, text)
  if (!clicked) {
    throw new Error(`找不到可点击元素：${text}`)
  }
  await sleep(300)
}

const tryClickText = async (text) => {
  try {
    await clickText(text)
    return true
  } catch {
    return false
  }
}

/** 侧边栏里的会话条目数量（统计列表容器里每个条目的标题元素） */
const siderSessionCount = () =>
  page.evaluate(() => {
    const sider = [...document.querySelectorAll('div[class]')].find((element) =>
      /(^|\s)sider-/.test(element.className)
    )
    if (!sider) {
      return -1
    }
    return sider.querySelectorAll('div[class*="title-"]').length
  })

/** 打开第一条会话的「更多」菜单（按钮默认隐藏，直接触发 click） */
const openSessionMenu = () =>
  page.evaluate(() => {
    const buttons = [...document.querySelectorAll('[aria-label="更多"]')]
    if (!buttons.length) {
      return false
    }
    buttons[0].click()
    return true
  })

/** 点击导出后从 blob URL 里取回 ZIP 内容，保存到 /shots 并校验 ZIP 魔数 */
const captureZip = async (clickTrigger, fileName) => {
  await page.evaluate(() => {
    const original = URL.createObjectURL
    if (!window.__capturedBlobs) {
      window.__capturedBlobs = []
      URL.createObjectURL = (blob) => {
        window.__capturedBlobs.push(blob)
        return original(blob)
      }
    }
    window.__capturedBlobs = []
  })
  await clickTrigger()
  const exported = await page.evaluate(async () => {
    const started = Date.now()
    while (Date.now() - started < 15000) {
      const blob = window.__capturedBlobs?.[0]
      if (blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        for (let index = 0; index < bytes.length; index += 1) {
          binary += String.fromCharCode(bytes[index])
        }
        return { size: bytes.length, base64: btoa(binary) }
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return null
  })
  if (!exported) {
    return false
  }
  const buffer = Buffer.from(exported.base64, 'base64')
  fs.writeFileSync(`${SHOTS}/${fileName}`, buffer)
  return buffer.subarray(0, 2).toString() === 'PK'
}

const uploadZip = async (fileName) => {
  const fileInput = await page.$('input[accept*=".zip"]')
  if (!fileInput) {
    return false
  }
  await fileInput.uploadFile(`${SHOTS}/${fileName}`)
  await sleep(700)
  return true
}

const username = `e2e_${Date.now().toString(36)}`
const password = 'e2e-password-123'

try {
  await page.goto(TARGET, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(600)
  await tryClickText('简体中文')
  await sleep(400)
  await shot('01-login')
  check('打开登录页', (await bodyText()).includes('登录'), TARGET)

  // ---- 注册 ----
  await clickText('注册一个')
  const inputs = await page.$$('input')
  await inputs[0].type(username)
  await inputs[1].type(password)
  await inputs[2].type(password)
  await page.click('button[type="submit"]')
  check(
    '注册后进入对话界面',
    await page
      .waitForSelector('textarea', { timeout: 20000 })
      .then(() => true)
      .catch(() => false)
  )
  await sleep(800)
  await shot('02-welcome')

  // ---- 发消息 ----
  await page.type('textarea', '你好，介绍一下你自己')
  await page.keyboard.press('Enter')
  check('流式回答渲染', await waitForText('你好！', 25000))
  check('思考过程区块', await waitForText('先想一想', 8000))
  const chatText = await bodyText()
  check('消息下方显示本次费用', chatText.includes('≈¥'))
  check('侧边栏显示这条对话的费用', (chatText.match(/≈¥/g) ?? []).length >= 2)
  await shot('03-chat')

  // ---- 置顶 ----
  check('打开会话菜单', await openSessionMenu())
  await sleep(300)
  await clickText('置顶')
  check('置顶分组出现', await waitForText('置顶', 8000))
  await shot('04-pinned')

  // ---- 刷新后历史仍在（服务端存储） ----
  await page.reload({ waitUntil: 'networkidle2' })
  await sleep(1200)
  check('刷新后会话标题出现在侧边栏', await waitForText(TITLE, 10000))
  const opened = await page.evaluate((title) => {
    const elements = [...document.querySelectorAll('div, button, span')]
    const target = elements.find(
      (element) => element.textContent?.trim() === title && element.children.length === 0
    )
    if (target) {
      target.click()
      return true
    }
    return false
  }, TITLE)
  check('点击历史会话', opened)
  check('历史对话内容恢复', await waitForText('你好！', 15000))
  await shot('05-history')

  // ---- 导出单条对话为 ZIP ----
  const singleZipOk = await captureZip(async () => {
    await openSessionMenu()
    await sleep(300)
    await clickText('导出为 ZIP')
  }, 'single-session.zip')
  check(
    '单条对话导出 ZIP',
    singleZipOk,
    singleZipOk ? `${fs.statSync(`${SHOTS}/single-session.zip`).size} bytes` : ''
  )
  await shot('06-export-single')

  // ---- 账号设置：绑定 API Key ----
  await clickText('设置')
  await sleep(400)
  await clickText('账号')
  await sleep(600)
  await shot('07-account')
  const accountText = await bodyText()
  check('账号页展示用户名', accountText.includes(username))
  const keyInput = await page.$('input[placeholder*="API Key"]')
  check('账号页有 API Key 输入框', Boolean(keyInput))
  if (keyInput) {
    await keyInput.type('sk-browser-bound-key-123456')
    await clickText('保存')
    check('绑定 API Key 成功（服务端校验+加密保存）', await waitForText('已绑定', 15000))
    await shot('08-account-bound')
  }

  // ---- 数据管理：追加导入 / 覆盖导入 ----
  await clickText('数据管理')
  await sleep(500)
  const beforeCount = await siderSessionCount()
  check('导入前会话数', beforeCount === 1, `当前 ${beforeCount} 条`)

  check('选择单条对话 ZIP', await uploadZip('single-session.zip'))
  await clickText('确认导入')
  check('追加导入成功（默认追加）', await waitForText('已导入 1 个对话', 30000))
  const afterAppend = await waitFor(
    async () => (await siderSessionCount()) === 2,
    10000
  )
  check('追加后会话数 +1（未覆盖原有对话）', afterAppend, `当前 ${await siderSessionCount()} 条`)
  await shot('09-import-append')

  check('再次选择同一 ZIP', await uploadZip('single-session.zip'))
  await clickText('覆盖现有对话')
  await clickText('确认导入')
  check('覆盖导入成功', await waitForText('已导入 1 个对话', 30000))
  const afterReplace = await waitFor(async () => (await siderSessionCount()) === 1, 10000)
  check('覆盖后只剩 1 条对话', afterReplace, `当前 ${await siderSessionCount()} 条`)
  await shot('10-import-replace')

  // ---- 导出全部对话 ----
  const allZipOk = await captureZip(() => clickText('下载'), 'all-sessions.zip')
  check('导出全部对话 ZIP', allZipOk)
  await shot('11-export-all')

  // ---- 退出登录 → 重新登录 ----
  await page.keyboard.press('Escape')
  await sleep(300)
  await clickText('设置')
  await sleep(400)
  await clickText('账号')
  await sleep(400)
  await clickText('退出登录')
  await sleep(400)
  await clickText('退出登录')
  check(
    '退出登录回到登录页',
    await page
      .waitForFunction(() => document.body.innerText.includes('还没有账号'), { timeout: 15000 })
      .then(() => true)
      .catch(() => false)
  )
  await shot('12-logged-out')

  const loginInputs = await page.$$('input')
  await loginInputs[0].type(username)
  await loginInputs[1].type(password)
  await page.click('button[type="submit"]')
  check(
    '重新登录成功',
    await page
      .waitForSelector('textarea', { timeout: 20000 })
      .then(() => true)
      .catch(() => false)
  )
  await sleep(1000)
  check('重新登录后历史仍在', await waitForText(TITLE, 10000))
  await shot('13-login-again')
} catch (error) {
  check(`未捕获异常：${error.message}`, false)
  await shot('99-error').catch(() => {})
} finally {
  if (pageErrors.length > 0) {
    // 未登录时 /api/auth/me 返回 401、http 页面下的 blob 提示都属于正常现象
    const real = pageErrors.filter(
      (error) =>
        !/401 \(Unauthorized\)/.test(error) && !/loaded over an insecure connection/.test(error)
    )
    results.push(`页面错误 ${real.length} 条（已忽略未登录 401 与 blob 安全提示）：`)
    for (const error of real.slice(0, 10)) {
      results.push(`  · ${error}`)
    }
    pageErrors.length = 0
    pageErrors.push(...real)
  }
  // eslint-disable-next-line no-console
  console.log(results.join('\n'))
  await browser.close()
  if (failures.length > 0 || pageErrors.length > 0) {
    process.exitCode = 1
  }
}
