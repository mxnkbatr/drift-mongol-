// Screenshot every daily condition (dev server only: uses ?cond=): node scripts/shots-conditions.mjs [url]
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const base = process.argv.find(a => a.startsWith('http')) ?? 'http://127.0.0.1:3000/'
const only = process.argv.find(a => /^(night|rain|dusk|fog|dawn)$/.test(a))
mkdirSync('shots', { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const errors = []
for (const cond of only ? [only] : ['night', 'rain', 'dusk', 'fog', 'dawn']) {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' })).newPage()
  page.on('pageerror', e => errors.push(`${cond}: ${e}`))
  page.on('console', m => m.type() === 'error' && errors.push(`${cond}: ${m.text()}`))
  await page.goto(`${base}?cond=${cond}`)
  await page.waitForSelector('#ui[data-screen="title"]', { timeout: 60_000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `shots/cond-${cond}-title.png` })
  await page.evaluate(() => {
    const { game, ui } = window.__game
    game.tutorial = false
    game.start()
    ui.show('hud')
    game.botPlay = true
  })
  // Let the bot reach the first corner, then capture mid-drift.
  await page.waitForFunction(() => window.__game.game.car.telemetry.drifting && window.__game.game.hud().run.elapsed > 4, null, { timeout: 60_000, polling: 100 }).catch(() => {})
  await page.waitForTimeout(600)
  await page.screenshot({ path: `shots/cond-${cond}-drift.png` })
  await page.close()
}
console.log('errors:', errors.length ? errors : 'none')
await browser.close()
