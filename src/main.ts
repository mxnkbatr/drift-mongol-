import './styles/main.css'
import { Audio } from './engine/audio'
import { I18n, resolveLocale } from './engine/i18n'
import { Input } from './engine/input'
import { GameLoop } from './engine/loop'
import { insertScore, SAVE_KEY, SaveStore, type SaveData } from './engine/save'
import { CONDITIONS, dailyFor, dayKey, type ConditionId } from './game/daily'
import type { Game } from './game/game'
import type { RunState } from './game/rules'
import { buildTrack, controlPointsForMap, findCorners } from './game/track'
import { challengeUrl, cleanName, decodeChallenge } from './online/challenge'
import { beatenPercent, Leaderboard, OnlineError, type RunStats } from './online/leaderboard'
import { canvasBlob, drawShareCard } from './online/share'
import { Ui } from './ui/ui'
import { registerGameTuning } from '../scripts/manus-tuning/adapter.js'
import { tuning } from './game/tuning'

type Ticket = { runId: Promise<string | null>; startedAt: number }
type Pending = { runId: string; score: number; durationMs: number; stats: RunStats }

async function boot(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')!
  const firstRun = safeGet(SAVE_KEY) === null
  const save = new SaveStore()
  const i18n = new I18n(resolveLocale(save.data.locale, navigator.languages))
  const input = new Input()
  const audio = new Audio()
  const params = new URLSearchParams(window.location.search)
  const target = decodeChallenge(params.get('vs'))
  // The daily condition is fixed by the UTC date; map/weather selection is a local free-run remix.
  const track = buildTrack(controlPointsForMap(save.data.mapId))
  const baseDaily = dailyFor(dayKey(), track, findCorners(track), save.data.mapId)
  const selectedCondition = save.data.weatherId === 'auto' ? baseDaily.condition : CONDITIONS[save.data.weatherId]
  // Dev-only QA override (?cond=rain); production always uses the date-seeded condition.
  const forced = import.meta.env.DEV ? (params.get('cond') as ConditionId | null) : null
  const daily = forced && CONDITIONS[forced] ? { ...baseDaily, condition: CONDITIONS[forced] } : { ...baseDaily, condition: selectedCondition }
  const lb = new Leaderboard(save.data.guest, guest => save.update({ guest }))
  let game: Game | undefined
  let ticket: Ticket | null = null
  let pending: Pending | null = null
  let lastRun: RunState | null = null
  let lastStanding: { day: number; all: number; pct: number } | null = null

  const applySettings = (d: SaveData) => {
    audio.setVolumes(d.musicVolume, d.sfxVolume, d.muted)
    if (game) game.reducedMotion = d.reducedMotion
  }
  const fallbackName = () => save.data.playerName || `Drifter-${Math.floor(1000 + Math.random() * 9000)}`

  const startRun = () => {
    if (!game) return
    audio.unlock()
    audio.startMusic()
    ui.closeModal()
    ticket = null
    pending = null
    game.tutorial = !save.data.tutorialDone
    tuning.activate('run')
    game.start()
    ui.show('hud')
    loop.resetAccumulator()
  }
  const pause = () => {
    if (game?.mode !== 'playing') return
    game.pause()
    ui.show('pause')
  }
  const resume = () => {
    if (game?.mode !== 'paused') return
    ui.closeModal()
    game.resume()
    ui.show('hud')
    loop.resetAccumulator()
  }

  const submit = async (p: Pending) => {
    ui.setOnline({ kind: 'posting' })
    try {
      await lb.rename(save.data.playerName)
      const r = await lb.submit(p.runId, p.score, p.durationMs, p.stats)
      pending = null
      const day = { rank: r.today.rank, total: r.today.total, pct: beatenPercent(r.today) }
      const all = { rank: r.all.rank, total: r.all.total, pct: beatenPercent(r.all) }
      lastStanding = { day: day.rank, all: all.rank, pct: day.pct }
      ui.setOnline({ kind: 'posted', day, all })
    } catch (e) {
      const code = e instanceof OnlineError ? e.code : 'offline'
      if (code === 'name') ui.setOnline({ kind: 'error', code, retry: false })
      else ui.setOnline({ kind: 'error', code, retry: code === 'offline' || code === 'busy' || code === 'rate' })
    }
  }

  const onEnd = async (run: RunState) => {
    const score = Math.round(run.score)
    const prevBest = save.data.best
    const newBest = score > prevBest
    const day = daily.day
    const { history } = insertScore(save.data.history, { score, at: Date.now(), day })
    save.update({
      best: Math.max(prevBest, score),
      bestDay: save.data.bestDay.day === day ? { day, score: Math.max(save.data.bestDay.score, score) } : { day, score },
      runs: save.data.runs + 1,
      history,
      tutorialDone: save.data.tutorialDone || run.stats.segments > 0,
    })
    lastRun = run
    lastStanding = null
    const t = ticket
    ticket = null
    window.setTimeout(() => ui.showResults(run, newBest), 1100)
    if (score <= 0) {
      ui.setOnline({ kind: 'none' })
      return
    }
    ui.setOnline({ kind: 'posting' })
    const runId = t ? await t.runId : null
    if (!runId) {
      ui.setOnline({ kind: 'error', code: lb.upgradeRequired ? 'upgrade' : 'offline', retry: false })
      return
    }
    pending = {
      runId,
      score,
      durationMs: Math.round(performance.now() - t!.startedAt),
      stats: { driftMs: Math.round(run.stats.driftMs), clips: run.stats.clips, nearMisses: run.stats.nearMisses, segments: run.stats.segments, maxMult: run.stats.maxMult, crashes: run.stats.crashes },
    }
    if (save.data.playerName) void submit(pending)
    else ui.setOnline({ kind: 'needName' })
  }

  const ui = new Ui(i18n, save, audio, input, daily, target, {
    play: startRun,
    restart: startRun,
    resume,
    quit: () => {
      game?.toTitle()
      ui.show('title')
    },
    settings: patch => {
      const routeChanged = (patch.mapId !== undefined && patch.mapId !== save.data.mapId) || (patch.weatherId !== undefined && patch.weatherId !== save.data.weatherId)
      const qualityChanged = patch.quality !== undefined && patch.quality !== save.data.quality
      save.update(patch)
      if (routeChanged) {
        window.location.reload()
        return
      }
      applySettings(save.data)
      if (patch.locale) i18n.set(patch.locale)
      if (qualityChanged) game?.setQuality(save.data.quality)
    },
    loadBoard: scope => lb.board(scope, 20),
    submitName: raw => {
      const name = cleanName(raw)
      if (!name) {
        ui.setOnline({ kind: 'error', code: 'name', retry: false })
        return
      }
      save.update({ playerName: name })
      if (pending) void submit(pending)
    },
    retrySubmit: () => {
      if (pending) void submit(pending)
    },
    copyLink: async () => {
      const url = linkFor()
      const text = `${i18n.t('share.text', { score: (lastRun?.score ?? save.data.best).toLocaleString('en-US') })} ${url}`
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        window.prompt(i18n.t('end.copy'), text)
        return false
      }
    },
    shareCard: async () => {
      const run = lastRun
      if (!run) return null
      const t = i18n.t.bind(i18n)
      const lines: string[] = []
      if (lastStanding) {
        lines.push(t('share.cardRank', { day: lastStanding.day, all: lastStanding.all }))
        lines.push(t('share.cardBeat', { pct: lastStanding.pct }))
      } else lines.push(t('share.cardBest', { n: Math.round(run.stats.bestSegment).toLocaleString('en-US') }))
      const card = drawShareCard({
        title: t('share.cardTitle'),
        subtitle: t('share.cardSub'),
        score: Math.round(run.score),
        scoreLabel: `${t('share.cardScore')}${save.data.playerName ? ` · ${save.data.playerName}` : ''}`,
        lines,
        rating: run.stats.bestRating > 0 ? t(`rating.${run.stats.bestRating}`) : '',
        cta: t('share.cta'),
        url: linkFor(),
        condition: t(`cond.${daily.condition.id}`),
        day: daily.day,
      })
      const blob = await canvasBlob(card)
      return { url: blob ? URL.createObjectURL(blob) : card.toDataURL('image/png'), blob }
    },
    shareSystem: async blob => {
      const text = i18n.t('share.text', { score: Math.round(lastRun?.score ?? 0).toLocaleString('en-US') })
      const file = blob ? new File([blob], 'drift-king.png', { type: 'image/png' }) : null
      try {
        if (file && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text, url: linkFor() })
        else await navigator.share({ text, url: linkFor() })
      } catch {
        // Cancelled share sheets are not errors.
      }
    },
    copyImage: async blob => {
      if (!blob || typeof ClipboardItem === 'undefined') return false
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
        return true
      } catch {
        return false
      }
    },
  })
  const linkFor = () => challengeUrl({ score: Math.round(lastRun?.score ?? save.data.best), name: save.data.playerName || 'Drifter', day: daily.day }, window.location.href)

  ui.show('boot')
  applySettings(save.data)
  let loaded = 0
  const step = <T>(p: Promise<T>): Promise<T> => p.then(v => (ui.setBootProgress(0.1 + (++loaded / 4) * 0.9), v))
  ui.setBootProgress(0.1)
  const [{ Game }, { Renderer, suggestQuality }, physics] = await Promise.all([
    step(import('./game/game')),
    step(import('./engine/renderer')),
    step(import('./engine/physics')),
    step(document.fonts.ready),
  ])
  await physics.initPhysics()
  if (firstRun) {
    save.update({ quality: suggestQuality() })
    ui.refreshSettings()
  }
  const renderer = new Renderer(canvas, save.data.quality)
  game = new Game(renderer, input, audio, daily, {
    event: (e, at) => {
      ui.event(e, at)
      if (e.type === 'start') {
        // Ask for the server run ticket as the clock starts; play never waits on it.
        const startedAt = performance.now()
        const runId = lb.upgradeRequired ? Promise.resolve(null) : lb.beginRun(fallbackName()).catch(() => null)
        ticket = { runId, startedAt }
      }
    },
    hint: h => ui.hint(h),
    end: run => void onEnd(run),
  }, !save.data.tutorialDone)
  game.reducedMotion = save.data.reducedMotion
  const g = game
  const loop = new GameLoop({
    step: dt => g.step(dt),
    render: (alpha, frameSeconds) => {
      input.update()
      if (input.method === 'touch' && !ui.touchActive) ui.setTouchActive(true)
      if (input.consume('pause')) {
        if (ui.modal) ui.closeModal()
        else if (g.mode === 'playing') pause()
        else if (g.mode === 'paused') resume()
      }
      if (!ui.modal) {
        const start = input.consume('start') || input.consume('confirm')
        if (start && ui.screen === 'title') startRun()
        else if (start && ui.canQuickRestart) startRun()
        else if (start && ui.screen === 'pause') resume()
        if (input.consume('back') && ui.screen === 'pause') resume()
      } else if (input.consume('back')) ui.closeModal()
      ui.frame(frameSeconds)
      loop.paused = g.mode === 'paused'
      g.render(alpha, frameSeconds)
      if (g.mode === 'playing' || g.mode === 'ended') ui.updateHud(g.hud())
      input.endFrame()
    },
  })
  loop.start()
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause()
  })
  window.addEventListener('game:pause', pause)
  window.setTimeout(() => ui.show('title'), 200)
  // Debug/test hook (read-only use): smoke tests inspect run state through it.
  ;(window as unknown as { __game: unknown }).__game = { game: g, ui, input, save, lb, daily, tuning }
  if (import.meta.env.DEV) void registerGameTuning(tuning)
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

boot().catch(err => {
  console.error(err)
  const el = document.getElementById('ui')
  if (el) el.innerHTML = `<div class="fatal">Failed to start: ${String((err as Error)?.message ?? err).replace(/[<>&]/g, '')}</div>`
})
