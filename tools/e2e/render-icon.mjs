/**
 * 把 SVG 图标渲染成 PNG（用于 apple-touch-icon 等需要位图的场景）。
 * 用法（在 dsw-e2e 镜像里）：node render-icon.mjs <input.svg> <output.png> [size] [bgColor]
 */
import fs from 'node:fs'
import puppeteer from 'puppeteer-core'

const [, , inputPath, outputPath, sizeArg, background = '#4D6BFE'] = process.argv
if (!inputPath || !outputPath) {
  console.error('用法：node render-icon.mjs <input.svg> <output.png> [size] [bgColor]')
  process.exit(1)
}
const size = Number.parseInt(sizeArg ?? '180', 10)
const svg = fs
  .readFileSync(inputPath, 'utf8')
  .replace(/<svg([^>]*)>/, (_, attributes) => {
    const cleaned = attributes.replace(/\s(?:width|height)="[^"]*"/g, '')
    return `<svg${cleaned} width="${size}" height="${size}">`
  })

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/chromium',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 })
  await page.setContent(
    `<html><head><style>html,body{margin:0;background:${background}}svg{display:block}</style></head><body>${svg}</body></html>`,
    { waitUntil: 'load' }
  )
  await page.screenshot({ path: outputPath, omitBackground: false })
  console.log(`已生成 ${outputPath}（${size}x${size}）`)
} finally {
  await browser.close()
}
