/**
 * 浏览器端冒烟测试（可选）：在容器里用 headless Chromium 走一遍真实用户流程。
 *
 * 运行方式（依赖 docker-compose.test.yml 已启动的 mock + web）：
 *   docker run --rm --network dpsk-self_default \
 *     -v "$PWD/tools/e2e:/e2e" -v "$PWD/docs/screenshots:/shots" \
 *     node:24-bookworm-slim sh -c "apt-get update -qq && apt-get install -y -qq chromium fonts-noto-cjk >/dev/null && cd /e2e && npm init -y >/dev/null && npm i puppeteer-core@23 --silent && node smoke.mjs"
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const TARGET = process.env.TARGET_URL ?? 'http://web:3080'
const SHOTS = process.env.SHOTS_DIR ?? '/shots'
const CHROME = process.env.CHROME_PATH ?? '/usr/bin/chromium'

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

const shot = async (name) => {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const bodyText = () => page.evaluate(() => document.body.innerText)

const waitForText = async (text, timeout = 20000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if ((await bodyText()).includes(text)) {
      return true
    }
    await sleep(200)
  }
  return false
}

const clickText = async (text) => {
  const clicked = await page.evaluate((needle) => {
    // 从后往前找：弹窗内容挂在 body 末尾，避免切到被遮罩挡住的同名按钮
    const elements = [...document.querySelectorAll('button, a, [role="tab"], [role="button"]')].reverse()
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

/** 可选点击：不存在时返回 false，不抛异常。 */
const tryClickText = async (text) => {
  const clicked = await page.evaluate((needle) => {
    // 从后往前找：弹窗内容挂在 body 末尾，避免切到被遮罩挡住的同名按钮
    const elements = [...document.querySelectorAll('button, a, [role="tab"], [role="button"]')].reverse()
    const match = elements.find((element) => element.textContent?.trim().includes(needle))
    if (match) {
      match.click()
      return true
    }
    return false
  }, text)
  if (clicked) {
    await sleep(300)
  }
  return clicked
}

const username = `e2e_${Date.now().toString(36)}`
const password = 'e2e-password-123'

try {
  await page.goto(TARGET, { waitUntil: 'networkidle2', timeout: 30000 })
  await sleep(600)
  // headless 浏览器默认语言通常是英文，先切到中文界面再验证
  await tryClickText('简体中文')
  await sleep(400)
  await shot('01-login')
  check('打开登录页', (await bodyText()).includes('登录'), TARGET)

  // ---- 注册 ----
  await clickText('注册一个')
  await shot('02-register')
  const inputs = await page.$$('input')
  await inputs[0].type(username)
  await inputs[1].type(password)
  await inputs[2].type(password)
  await page.click('button[type="submit"]')
  const enteredChat = await page
    .waitForSelector('textarea', { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  check('注册后进入对话界面', enteredChat)
  await sleep(800)
  await shot('03-welcome')

  // ---- 对话 ----
  await page.type('textarea', '你好，介绍一下你自己')
  await page.keyboard.press('Enter')
  const replied = await waitForText('你好！', 25000)
  check('流式回答渲染', replied)
  const thinking = (await bodyText()).includes('已思考') || (await bodyText()).includes('思考')
  check('思考过程区块', thinking)
  const hasCost = (await bodyText()).includes('≈¥')
  check('回答下方显示费用估算', hasCost)
  await shot('04-chat')

  // ---- 刷新后历史仍在（服务端存储） ----
  await page.reload({ waitUntil: 'networkidle2' })
  await sleep(1200)
  const sessionTitle = '测试会话标题'
  const titleVisible = await waitForText(sessionTitle, 10000)
  check('刷新后会话标题出现在侧边栏', titleVisible)
  if (titleVisible) {
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
    }, sessionTitle)
    check('点击历史会话', opened)
    const historyLoaded = await waitForText('你好！', 15000)
    check('历史对话内容恢复', historyLoaded)
  }
  await shot('05-history')

  // ---- 设置 → 账号：绑定 API Key ----
  await clickText('设置')
  await sleep(400)
  await clickText('账号')
  await sleep(500)
  await shot('06-account')
  const accountText = await bodyText()
  check('账号页展示用户名', accountText.includes(username))
  const keyInput = await page.$('input[placeholder*="API Key"]')
  check('账号页有 API Key 输入框', Boolean(keyInput))
  if (keyInput) {
    await keyInput.type('sk-browser-bound-key-123456')
    await clickText('保存')
    const saved = await waitForText('已绑定', 15000)
    check('绑定 API Key 成功（服务端校验+加密保存）', saved)
    await shot('07-account-bound')
  }

  // ---- 关闭设置后刷新，绑定状态仍在 ----
  await page.keyboard.press('Escape')
  await sleep(300)
  await page.reload({ waitUntil: 'networkidle2' })
  await sleep(1200)
  await clickText('设置')
  await sleep(400)
  await clickText('账号')
  await sleep(600)
  const afterReload = await bodyText()
  check('刷新后 API Key 仍为已绑定状态', afterReload.includes('已绑定'))
  await shot('08-account-after-reload')

  // ---- ZIP 导出 / 导入（分享或搬家到别的实例） ----
  await clickText('数据管理')
  await sleep(500)
  await page.evaluate(() => {
    const original = URL.createObjectURL
    window.__exported = []
    URL.createObjectURL = (blob) => {
      window.__exported.push(blob)
      return original(blob)
    }
  })
  await clickText('下载')
  const exported = await page.evaluate(async () => {
    const started = Date.now()
    while (Date.now() - started < 15000) {
      const blob = window.__exported?.[0]
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
  check('导出历史 ZIP', Boolean(exported) && exported.size > 100, exported ? `${exported.size} bytes` : '')
  if (exported) {
    fs.writeFileSync(`${SHOTS}/export.zip`, Buffer.from(exported.base64, 'base64'))
    check('ZIP 文件头正确（PK）', fs.readFileSync(`${SHOTS}/export.zip`).subarray(0, 2).toString() === 'PK')
  }
  await shot('09-export')

  if (exported) {
    // 只选设置里带 ZIP 过滤条件的导入输入框，避免误选聊天输入框的上传入口
    const fileInput = await page.$('input[accept*=".zip"]')
    if (!fileInput) {
      check('找到导入 ZIP 的文件选择框', false)
    } else {
      await fileInput.uploadFile(`${SHOTS}/export.zip`)
      await sleep(800)
      await clickText('确认导入')
      const imported = await waitForText('已导入', 30000)
      check('导入同一 ZIP 覆盖成功', imported)
      await shot('10-import')
      await page.keyboard.press('Escape')
      await sleep(400)
      check('导入后会话仍在', await waitForText('测试会话标题', 15000))
    }
  }

  // ---- 退出登录 → 重新登录 ----
  await clickText('设置')
  await sleep(400)
  await clickText('账号')
  await sleep(400)
  await clickText('退出登录')
  await sleep(400)
  await clickText('退出登录')
  const backToLogin = await page
    .waitForFunction(() => document.body.innerText.includes('还没有账号'), { timeout: 15000 })
    .then(() => true)
    .catch(() => false)
  check('退出登录回到登录页', backToLogin)
  await shot('11-logged-out')

  const loginInputs = await page.$$('input')
  await loginInputs[0].type(username)
  await loginInputs[1].type(password)
  await page.click('button[type="submit"]')
  const reEntered = await page
    .waitForSelector('textarea', { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  check('重新登录成功', reEntered)
  await sleep(1000)
  check('重新登录后历史仍在', await waitForText('测试会话标题', 10000))
  await shot('12-login-again')
} catch (error) {
  check(`未捕获异常：${error.message}`, false)
  await shot('99-error').catch(() => {})
} finally {
  if (pageErrors.length > 0) {
    // 未登录时 /api/auth/me 返回 401、blob 下载在 http 页面下的提示都属于正常现象
    const real = pageErrors.filter(
      (error) => !/401 \(Unauthorized\)/.test(error) && !/loaded over an insecure connection/.test(error)
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
