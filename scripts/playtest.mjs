// Automated playtest: screenshots of title / HUD / results, a short keyboard drive and bot runs
// fast-forwarded through the fixed-step simulation. Usage:
//   node scripts/playtest.mjs [url] [--bots N] [--mobile] [--out dir]
import { mkdirSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const url = args.find(a => a.startsWith('http')) ?? 'http://127.0.0.1:3000/'
const bots = Number(args[args.indexOf('--bots') + 1] ?? 0) || 0
const mobile = args.includes('--mobile')
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'shots'
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
const context = await browser.newContext(mobile
  ? { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN' }
  : { viewport: { width: 1280, height: 720 }, locale: args.includes('--en') ? 'en-US' : 'zh-CN' })
const page = await context.newPage()
const errors = []
page.on('console', m => (m.type() === 'error' || m.type() === 'warning') && errors.push(`${m.type()}: ${m.text()}`))
page.on('pageerror', e => errors.push(`pageerror: ${e}`))
page.on('response', r => r.status() >= 400 && !r.url().includes('/api/') && errors.push(`HTTP ${r.status()} ${r.url()}`))
const t0 = Date.now()
await page.goto(url)
await page.waitForSelector('#ui[data-screen="title"]', { timeout: 60_000 })
console.log(`title after ${Date.now() - t0} ms`)
await page.waitForTimeout(1500)
await page.screenshot({ path: `${out}/01-title.png` })
const snap = () => page.evaluate(() => {
  const { game } = window.__game
  const h = game.hud()
  return { mode: game.mode, phase: h.run.phase, score: Math.round(h.run.score), time: +h.run.timeLeft.toFixed(1), speed: +h.speed.toFixed(1), slip: +h.slip.toFixed(1), seg: Math.round(h.segmentValue), mult: h.run.seg.mult, stats: h.run.stats }
})

if (mobile) {
  await page.tap('[data-act="play"]', { force: true })
} else {
  await page.keyboard.press('Space')
}
await page.waitForTimeout(700)
await page.screenshot({ path: `${out}/02-ready.png` })
// Keyboard drive: launch, then turn + handbrake into the first corner.
if (!mobile) {
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(2600)
  console.log('after launch', await snap())
  await page.keyboard.down('KeyA')
  await page.keyboard.down('Space')
  await page.waitForTimeout(350)
  await page.keyboard.up('Space')
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${out}/03-drift.png` })
  console.log('drifting', await snap())
  await page.keyboard.up('KeyA')
  await page.keyboard.down('KeyD')
  await page.waitForTimeout(500)
  await page.keyboard.up('KeyD')
  await page.waitForTimeout(1500)
  await page.keyboard.up('KeyW')
  console.log('after manual', await snap())
} else {
  const box = await page.locator('[data-c="throttle"]').boundingBox()
  console.log('gas button', box)
  await page.screenshot({ path: `${out}/03-touch-hud.png` })
}

// Bot runs, fast-forwarded (no rendering between steps).
const results = []
for (let i = 0; i < Math.max(1, bots); i += 1) {
  const r = await page.evaluate(async (first) => {
    const { game } = window.__game
    if (!first) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }))
    await new Promise(res => setTimeout(res, 300))
    game.botPlay = true
    const firstScoreAt = { t: null }
    let steps = 0
    while (game.mode === 'playing' && steps < 60 * 80) {
      for (let k = 0; k < 120 && game.mode === 'playing'; k += 1) {
        game.step(1 / 60)
        steps += 1
        const run = game.hud().run
        if (firstScoreAt.t === null && run.score > 0) firstScoreAt.t = +(60 - run.timeLeft).toFixed(1)
      }
      await new Promise(res => setTimeout(res, 0))
    }
    game.botPlay = false
    const run = game.hud().run
    return { mode: game.mode, score: Math.round(run.score), firstScoreAt: firstScoreAt.t, stats: run.stats, steps }
  }, i === 0)
  results.push(r)
  console.log(`bot run ${i + 1}:`, JSON.stringify(r))
  await page.waitForTimeout(1800)
  if (i === 0) await page.screenshot({ path: `${out}/04-results.png` })
  // Close any post-run input focus so Enter restarts.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.waitForTimeout(800)
}
await page.screenshot({ path: `${out}/05-final.png` })
writeFileSync(`${out}/playtest.json`, JSON.stringify({ results, errors }, null, 2))
console.log('console errors/warnings:', errors.length ? errors : 'none')
await browser.close()
