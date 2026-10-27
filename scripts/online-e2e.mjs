// Real-time online integration test: bot plays one full 60 s run in the production build, posts
// the score with a nickname, checks rank / percentile UI, share card, challenge link round trip.
// Usage: node scripts/online-e2e.mjs [url=http://127.0.0.1:4400/]
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://127.0.0.1:4400/'
mkdirSync('shots', { recursive: true })
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN', permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
const errors = []
page.on('console', m => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', e => errors.push(String(e)))
await page.goto(url)
await page.waitForSelector('#ui[data-screen="title"]', { timeout: 60_000 })
await page.keyboard.press('Enter')
await page.evaluate(() => { window.__game.game.botPlay = true })
console.log('bot driving 60 s in real time…')
await page.waitForSelector('#ui[data-screen="results"]', { timeout: 110_000 })
await page.waitForSelector('.res-online input.name, .res-online .ranks, .res-online .err', { timeout: 20_000 })
const needName = await page.$('.res-online input.name')
console.log('name form shown:', !!needName)
if (needName) {
  await page.fill('.res-online input.name', `测试车手${Date.now().toString(36).slice(-3)}`)
  await page.press('.res-online input.name', 'Enter')
}
await page.waitForSelector('.res-online .ranks, .res-online .err', { timeout: 20_000 })
const onlineText = await page.textContent('.res-online')
console.log('online box:', onlineText?.replace(/\s+/g, ' ').trim())
await page.waitForTimeout(1200)
await page.screenshot({ path: 'shots/e2e-results.png' })
// Share card.
await page.click('[data-act="share"]')
await page.waitForSelector('.modal.share.on img[src^="blob:"]', { timeout: 10_000 })
await page.waitForTimeout(400)
await page.screenshot({ path: 'shots/e2e-share.png' })
const card = await page.evaluate(async () => {
  const img = document.querySelector('.modal.share img')
  return { w: img.naturalWidth, h: img.naturalHeight }
})
console.log('share card size', card)
await page.click('.modal.share [data-act="close"]')
// Challenge link.
await page.click('[data-act="copyLink"]')
await page.waitForTimeout(300)
const clip = await page.evaluate(() => navigator.clipboard.readText())
console.log('clipboard:', clip)
const link = clip.match(/https?:\/\/\S+/)?.[0]
// Leaderboard modal.
await page.click('.results [data-act="boards"]')
await page.waitForSelector('.board-list li:not(.empty), .board-list li.empty', { timeout: 10_000 })
await page.waitForTimeout(500)
await page.screenshot({ path: 'shots/e2e-boards.png' })
console.log('today board:', (await page.textContent('.board-list'))?.replace(/\s+/g, ' ').slice(0, 200))
await page.click('[data-act="tab-all"]')
await page.waitForTimeout(800)
console.log('all board:', (await page.textContent('.board-list'))?.replace(/\s+/g, ' ').slice(0, 200))
await page.click('.modal.boards [data-act="close"]')
// Space restarts immediately.
await page.keyboard.press('Space')
await page.waitForTimeout(400)
console.log('after Space screen:', await page.getAttribute('#ui', 'data-screen'))
// Open the challenge link as a new player.
if (link) {
  const p2 = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })).newPage()
  p2.on('pageerror', e => errors.push(String(e)))
  await p2.goto(link)
  await p2.waitForSelector('#ui[data-screen="title"]', { timeout: 60_000 })
  await p2.waitForTimeout(1000)
  console.log('challenge card:', (await p2.textContent('.challenge-card'))?.replace(/\s+/g, ' ').trim(), 'visible:', await p2.isVisible('.challenge-card'))
  await p2.screenshot({ path: 'shots/e2e-challenge-title.png' })
  await p2.keyboard.press('Space')
  await p2.waitForTimeout(1500)
  console.log('hud target:', (await p2.textContent('.hud .target'))?.trim())
  await p2.screenshot({ path: 'shots/e2e-challenge-hud.png' })
}
console.log('console errors:', errors.length ? errors : 'none')
await browser.close()
