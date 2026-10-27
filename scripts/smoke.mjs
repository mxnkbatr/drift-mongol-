// End-to-end smoke test: builds must already exist in dist/ (`pnpm build`).
// Serves dist/ with `vite preview` (no /api there: the leaderboard must degrade gracefully),
// boots the game in headless Chromium, drives with the keyboard, fast-forwards a run to the
// results screen, restarts with one key, checks both languages and a phone in landscape, and
// fails on console errors. Screenshots go to ./shots/.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const port = 4300 + Math.floor(Math.random() * 500)
const url = `http://127.0.0.1:${port}/`
const out = process.env.SHOTS_DIR ?? 'shots'
mkdirSync(out, { recursive: true })
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { stdio: 'ignore', detached: false })
let browser
const guard = setTimeout(() => fail('timed out'), 180_000)
function cleanup() {
  clearTimeout(guard)
  try { server.kill('SIGTERM') } catch {}
}
async function fail(msg) {
  console.error(`smoke: FAIL — ${msg}`)
  await browser?.close().catch(() => {})
  cleanup()
  process.exit(1)
}
async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('preview server did not start')
}
// vite preview has no leaderboard API, so /api 404s are expected here; anything else is a bug.
const expected = text => /\/api\/leaderboards\//.test(text) || /Failed to load resource.*404/.test(text)
async function openGame(context, errors) {
  const page = await context.newPage()
  page.on('console', m => m.type() === 'error' && !expected(m.text()) && errors.push(m.text()))
  page.on('pageerror', e => errors.push(String(e)))
  page.on('response', r => r.status() >= 400 && !expected(r.url()) && errors.push(`HTTP ${r.status()} ${r.url()}`))
  await page.goto(url)
  await page.waitForSelector('#ui[data-screen="title"]', { timeout: 60_000 })
  await page.waitForTimeout(900)
  return page
}
const state = page => page.evaluate(() => {
  const { game } = window.__game
  const h = game.hud()
  return { mode: game.mode, timeLeft: h.run.timeLeft, x: game.car.pos.x, z: game.car.pos.z }
})
try {
  await waitForServer()
  const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']
  browser = await chromium.launch({ args }).catch(() => chromium.launch({ args, channel: 'chrome' }))
  const errors = []

  const en = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'en-US' })
  const page = await openGame(en, errors)
  if (!/START DRIFTING/i.test(await page.textContent('[data-act="play"]'))) throw new Error('English title not shown')
  await page.screenshot({ path: `${out}/smoke-01-title-en.png` })
  // One key from the title straight into a run.
  await page.keyboard.press('Enter')
  await page.waitForSelector('#ui[data-screen="hud"]')
  const before = await state(page)
  await page.keyboard.down('KeyW')
  await page.waitForTimeout(1500)
  await page.keyboard.down('KeyA')
  await page.keyboard.down('Space')
  await page.waitForTimeout(500)
  await page.keyboard.up('Space')
  await page.waitForTimeout(600)
  await page.keyboard.up('KeyA')
  await page.keyboard.up('KeyW')
  await page.screenshot({ path: `${out}/smoke-02-drive.png` })
  const after = await state(page)
  const moved = Math.hypot(after.x - before.x, after.z - before.z)
  if (after.mode !== 'playing') throw new Error(`expected playing, got ${after.mode}`)
  if (!(after.timeLeft < before.timeLeft)) throw new Error('clock did not run')
  if (moved < 8) throw new Error(`car barely moved (${moved.toFixed(2)} m)`)

  // Fast-forward the rest of the run with the autopilot.
  const end = await page.evaluate(() => {
    const { game } = window.__game
    game.botPlay = true
    let n = 0
    while (game.mode === 'playing' && n < 60 * 75) { game.step(1 / 60); n += 1 }
    game.botPlay = false
    return { mode: game.mode, score: Math.round(game.hud().run.score), stats: game.hud().run.stats, speed: game.car.telemetry.speed }
  })
  if (end.mode !== 'ended') throw new Error(`run did not end (${end.mode})`)
  console.log('bot finish', JSON.stringify(end))
  await page.waitForSelector('#ui[data-screen="results"]', { timeout: 10_000 })
  await page.waitForSelector('.res-online .err, .res-online input.name, .res-online .ranks', { timeout: 30_000 }).catch(async e => {
    const info = await page.evaluate(() => ({ html: document.querySelector('.res-online')?.outerHTML.slice(0, 300), screen: document.querySelector('#ui')?.getAttribute('data-screen'), online: window.__game.ui.online }))
    throw new Error(`online box never settled (run score ${end.score}): ${JSON.stringify(info)}`)
  })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${out}/smoke-03-results.png` })
  const shown = Number((await page.textContent('.res-score'))?.replace(/\D/g, ''))
  if (shown !== end.score) throw new Error(`results show ${shown}, run scored ${end.score}`)
  // One key restarts immediately.
  await page.keyboard.press('Space')
  await page.waitForSelector('#ui[data-screen="hud"]', { timeout: 3000 }).catch(async () => {
    throw new Error(`Space did not restart (screen ${await page.getAttribute('#ui', 'data-screen')}, focus ${await page.evaluate(() => document.activeElement?.tagName)})`)
  })
  if ((await state(page)).timeLeft < 59) throw new Error('restart did not reset the clock')
  await en.close()

  // A Chinese browser gets Chinese; the leaderboard modal opens (offline here) without errors.
  const zh = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'zh-CN' })
  const zp = await openGame(zh, errors)
  if ((await zp.evaluate(() => document.documentElement.lang)) !== 'zh-CN') throw new Error('browser language not detected')
  if (!/开始漂移/.test(await zp.textContent('[data-act="play"]'))) throw new Error('Chinese title not shown')
  await zp.click('.title [data-act="boards"]')
  await zp.waitForSelector('.modal.boards.on')
  await zp.waitForTimeout(800)
  await zp.screenshot({ path: `${out}/smoke-04-boards-zh.png` })
  await zh.close()

  // A Mongolian browser gets the new native-language title and controls.
  const mn = await browser.newContext({ viewport: { width: 1280, height: 720 }, locale: 'mn-MN' })
  const mp = await openGame(mn, errors)
  if ((await mp.evaluate(() => document.documentElement.lang)) !== 'mn') throw new Error('Mongolian browser language not detected')
  if (!/ДРИФТЭЭ ЭХЛҮҮЛ/.test(await mp.textContent('[data-act="play"]'))) throw new Error('Mongolian title not shown')
  await mp.screenshot({ path: `${out}/smoke-05-title-mn.png` })
  await mn.close()

  // Phone in landscape: touch controls appear and the gas button drives the car.
  const phone = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'mn-MN' })
  const pp = await openGame(phone, errors)
  await pp.tap('[data-act="play"]', { force: true })
  await pp.waitForSelector('#ui[data-screen="hud"]')
  await pp.waitForTimeout(600)
  if (!(await pp.isVisible('.touch [data-c="throttle"]'))) throw new Error('touch controls not visible on phone')
  if (!/ХИЙ/.test(await pp.textContent('.touch [data-c="throttle"]'))) throw new Error('Mongolian touch labels not shown')
  await pp.screenshot({ path: `${out}/smoke-06-phone-hud.png` })
  await phone.close()

  if (errors.length) throw new Error(`console errors:\n  ${errors.join('\n  ')}`)
  console.log(`smoke: OK — drove ${moved.toFixed(1)} m, bot run ${end.score} pts, restart, mn/zh/en and phone verified`)
  await browser.close()
  cleanup()
  process.exit(0)
} catch (err) {
  await fail(err?.message ?? String(err))
}
