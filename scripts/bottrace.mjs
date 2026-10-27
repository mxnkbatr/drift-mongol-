// Bot telemetry trace for tuning: node scripts/bottrace.mjs [url] [--runs N] [--style '{"drift":0.8}']
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const url = args.find(a => a.startsWith('http')) ?? 'http://127.0.0.1:3000/'
const runs = Number(args[args.indexOf('--runs') + 1] ?? 1) || 1
const style = args.includes('--style') ? JSON.parse(args[args.indexOf('--style') + 1]) : null
const quiet = args.includes('--quiet')
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))
await page.goto(url)
await page.waitForSelector('#ui[data-screen="title"]', { timeout: 60_000 })
const all = []
for (let r = 0; r < runs; r += 1) {
  const res = await page.evaluate(async ({ style }) => {
    const { game } = window.__game
    const ui = window.__game.ui
    ui.closeModal()
    game.tutorial = false
    game.start()
    ui.show('hud')
    if (style) Object.assign(game.pilot.style, style)
    game.botPlay = true
    const trace = []
    let steps = 0
    let contacts = 0
    const events = []
    const orig = game.hooks.event
    game.hooks.event = (e, at) => { events.push({ t: +(60 - game.hud().run.timeLeft).toFixed(1), type: e.type, ...(e.points !== undefined ? { p: Math.round(e.points) } : {}), ...(e.reason ? { r: e.reason } : {}), ...(e.rating !== undefined ? { rt: e.rating } : {}) }); orig(e, at) }
    while (game.mode === 'playing' && steps < 60 * 70) {
      game.step(1 / 60)
      steps += 1
      const tel = game.car.telemetry
      if (tel.contact) contacts += 1
      if (steps % 15 === 0) {
        const h = game.hud()
        trace.push([+(60 - h.run.timeLeft).toFixed(2), +tel.speed.toFixed(1), +tel.slip.toFixed(0), tel.drifting ? 1 : 0, tel.contact ? 1 : 0, Math.round(h.run.score), Math.round(h.segmentValue), h.run.seg.mult, +h.wallGap.toFixed(1)])
      }
    }
    game.hooks.event = orig
    game.botPlay = false
    const run = game.hud().run
    game.toTitle()
    ui.show('title')
    return { score: Math.round(run.score), stats: run.stats, contacts, trace, events }
  }, { style })
  all.push(res)
  console.log(`run ${r + 1}: score ${res.score} contacts ${res.contacts} stats ${JSON.stringify(res.stats)}`)
  if (!quiet) {
    console.log('t speed slip drift contact score seg mult wallGap')
    for (const row of res.trace) console.log(row.join(' '))
    console.log('events', JSON.stringify(res.events))
  }
}
const scores = all.map(r => r.score)
console.log('scores', scores.join(', '), 'avg', Math.round(scores.reduce((a, b) => a + b, 0) / scores.length))
if (errors.length) console.log('errors', errors)
await browser.close()
