import type { Audio } from '../engine/audio'
import type { I18n } from '../engine/i18n'
import type { Input, TouchControl } from '../engine/input'
import type { Locale, MapId, Quality, SaveData, SaveStore, WeatherSelection } from '../engine/save'
import type { Daily } from '../game/daily'
import type { Hint, HudState } from '../game/game'
import { formatClock, type DriftEvent, type RunState } from '../game/rules'
import type { Challenge } from '../online/challenge'
import type { BoardView, Scope } from '../online/leaderboard'
import { MAPS } from '../game/track'

export type Screen = 'boot' | 'title' | 'hud' | 'pause' | 'results'
export type Modal = 'boards' | 'share' | 'settings' | 'route' | null

export type UiActions = {
  play(): void
  restart(): void
  resume(): void
  quit(): void
  settings(patch: Partial<SaveData>): void
  loadBoard(scope: Scope): Promise<BoardView>
  submitName(name: string): void
  retrySubmit(): void
  copyLink(): Promise<boolean>
  shareCard(): Promise<{ url: string; blob: Blob | null } | null>
  shareSystem(blob: Blob | null): Promise<void>
  copyImage(blob: Blob | null): Promise<boolean>
}

/** What the results screen shows about the online side of the run. */
export type OnlineStatus =
  | { kind: 'none' }
  | { kind: 'needName' }
  | { kind: 'posting' }
  | { kind: 'posted'; day: { rank: number; total: number; pct: number }; all: { rank: number; total: number; pct: number } }
  | { kind: 'error'; code: string; retry: boolean }

const fmt = (n: number) => Math.round(n).toLocaleString('en-US')
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)

function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template')
  t.innerHTML = html.trim()
  return t.content.firstElementChild as T
}

/**
 * All HTML/CSS game UI. Screens are built once and relocalized in place; gameplay pushes state in
 * through `updateHud`, `event`, `hint` and `showResults`, and the UI calls back through actions.
 */
export class Ui {
  screen: Screen = 'boot'
  modal: Modal = null
  private readonly root: HTMLElement
  private readonly screens: Record<Screen, HTMLElement>
  private readonly modals: Record<Exclude<Modal, null>, HTMLElement>
  private readonly popups: HTMLElement
  private readonly hintEl: HTMLElement
  private readonly toastEl: HTMLElement
  private readonly touch: HTMLElement
  private lastScore = -1
  private lastSeg = -1
  private lastMult = 1
  private pbToasted = false
  private targetToasted = false
  private lastTenToasted = false
  private hintKey: Hint = null
  private resultsAt = 0
  private boardScope: Scope = 'day'
  private endRun?: RunState
  private endNewBest = false
  private online: OnlineStatus = { kind: 'none' }
  private countUp = { from: 0, to: 0, t: 1 }
  private shareBlob: Blob | null = null
  private shareUrl = ''
  touchActive = false

  constructor(
    private readonly i18n: I18n,
    private readonly save: SaveStore,
    private readonly audio: Audio,
    private readonly input: Input,
    private readonly daily: Daily,
    private readonly target: Challenge | null,
    private readonly actions: UiActions,
  ) {
    this.root = document.getElementById('ui')!
    this.screens = {
      boot: el(`<section class="screen boot"><div class="logo small"><span data-t="title.name"></span></div><div class="bar"><i></i></div><p data-t="boot.loading"></p></section>`),
      title: this.buildTitle(),
      hud: this.buildHud(),
      pause: el(`<section class="screen pause"><div class="panel"><h2 class="stroke" data-t="pause.title"></h2>
        <button class="btn primary" data-act="resume" data-t="pause.resume"></button>
        <button class="btn" data-act="restart" data-t="pause.restart"></button>
        <button class="btn" data-act="settings" data-t="title.settings"></button>
        <button class="btn ghost" data-act="quit" data-t="pause.quit"></button></div></section>`),
      results: this.buildResults(),
    }
    this.modals = {
      boards: this.buildBoards(),
      share: el(`<div class="modal share"><div class="panel wide"><h2 class="stroke" data-t="share.title"></h2>
        <div class="card-preview"><img alt="" /></div>
        <div class="row"><a class="btn primary" data-act="download" download="drift-king.png" data-t="share.download"></a>
        <button class="btn" data-act="system" data-t="share.system"></button>
        <button class="btn" data-act="copyImg" data-t="share.copyImg"></button>
        <button class="btn" data-act="copyLink2" data-t="end.copy"></button></div>
        <p class="note" data-ref="shareNote"></p>
        <button class="btn ghost" data-act="close" data-t="common.close"></button></div></div>`),
      settings: this.buildSettings(),
      route: this.buildRoute(),
    }
    this.popups = el(`<div class="popups"></div>`)
    this.hintEl = el(`<div class="hint"></div>`)
    this.toastEl = el(`<div class="toasts"></div>`)
    this.touch = this.buildTouch()
    const rotate = el(`<div class="rotate"><div class="phone"></div><p data-t="rotate"></p></div>`)
    for (const s of Object.values(this.screens)) this.root.append(s)
    this.root.append(this.popups, this.hintEl, this.toastEl, this.touch, ...Object.values(this.modals), rotate)
    this.root.addEventListener('click', e => this.onClick(e))
    this.root.addEventListener('pointerdown', () => this.audio.unlock(), { capture: true })
    this.i18n.onChange(() => this.relocalize())
    this.relocalize()
    if (matchMedia('(pointer: coarse)').matches) this.setTouchActive(true)
    window.addEventListener('touchstart', () => this.setTouchActive(true), { passive: true })
  }

  // ─── construction ──────────────────────────────────────────────────────
  private buildTitle(): HTMLElement {
    return el(`<section class="screen title">
      <div class="title-left">
        <div class="logo"><span class="mn">ДРИФТИЙН ХААН · ТАЛЫН НЕОН</span><span class="zh">漂移之王 · 草原霓虹</span><span class="en">DRIFT KING // STEPPE NEON</span></div>
        <p class="tag" data-t="title.tag"></p>
        <button class="btn play primary" data-act="play"><span data-t="title.play"></span><small data-t="title.press"></small></button>
        <div class="how">
          <div class="how-card"><b data-t="how.drive"></b><kbd data-t="how.driveKeys"></kbd></div>
          <div class="how-card hot"><b data-t="how.hb"></b><kbd data-t="how.hbKeys"></kbd></div>
        </div>
        <ul class="rules"><li class="r1" data-t="how.goal"></li><li class="r2" data-t="how.crash"></li><li class="r3" data-t="how.clip"></li></ul>
        <p class="pad" data-t="how.pad"></p>
        <p class="touch-how" data-t="how.touch"></p>
      </div>
      <div class="title-right">
        <div class="challenge-card" data-ref="vs" hidden><div class="label">VS</div><div class="vs-name" data-ref="vsName"></div><div class="vs-score" data-ref="vsScore"></div></div>
        <div class="daily-card"><div class="label" data-t="title.daily"></div><div class="cond" data-ref="cond"></div><div class="cond-d" data-ref="condD"></div><div class="day" data-ref="day"></div></div>
        <div class="best-card" data-ref="best"></div>
        <div class="title-buttons">
          <button class="btn" data-act="boards" data-t="title.boards"></button>
          <button class="btn" data-act="route" data-t="title.route"></button>
          <button class="btn" data-act="settings" data-t="title.settings"></button>
          <button class="btn ghost small" data-act="lang" data-t="title.lang"></button>
        </div>
      </div>
    </section>`)
  }

  private buildHud(): HTMLElement {
    return el(`<section class="screen hud">
      <div class="hud-score"><div class="label" data-t="hud.score"></div><div class="value" data-ref="score">0</div>
        <div class="sub" data-ref="bestLine"></div>
        <div class="target" data-ref="targetBox" hidden><div class="tlabel" data-ref="targetLabel"></div><div class="tbar"><i data-ref="targetFill"></i></div></div>
      </div>
      <div class="hud-time"><div class="label" data-t="hud.time"></div><div class="value" data-ref="time">60</div><div class="heat" data-ref="heat"></div></div>
      <div class="hud-speed"><div class="value" data-ref="speed">0</div><div class="label" data-t="hud.kmh"></div><button class="icon-btn" data-act="pause" aria-label="pause">❚❚</button></div>
      <div class="drift" data-ref="drift">
        <div class="drift-mult" data-ref="mult">×1</div>
        <div class="drift-value" data-ref="seg">0</div>
        <div class="drift-meta"><span data-ref="angle">0°</span><span class="clipzone" data-ref="clipTag" data-t="hud.clipZone"></span><span class="holdit" data-ref="hold" data-t="hud.hold"></span></div>
        <div class="grace"><i data-ref="grace"></i></div>
      </div>
      <div class="wall-warn" data-ref="wall"></div>
    </section>`)
  }

  private buildResults(): HTMLElement {
    return el(`<section class="screen results"><div class="panel results-panel">
      <h2 class="stroke big" data-t="end.title"></h2>
      <div class="res-grid">
        <div class="res-main">
          <div class="label" data-t="end.score"></div>
          <div class="res-score" data-ref="resScore">0</div>
          <div class="stamp" data-ref="resStamp"></div>
          <div class="res-best" data-ref="resBest"></div>
          <div class="res-target" data-ref="resTarget"></div>
          <div class="res-stats" data-ref="resStats"></div>
        </div>
        <div class="res-online" data-ref="resOnline"></div>
      </div>
      <div class="res-buttons">
        <button class="btn primary big" data-act="restart"><span data-t="end.again"></span><small data-t="end.againKey"></small></button>
        <button class="btn" data-act="share" data-t="end.share"></button>
        <button class="btn" data-act="copyLink" data-t="end.copy"></button>
        <button class="btn" data-act="boards" data-t="end.boards"></button>
        <button class="btn ghost" data-act="quit" data-t="end.title2"></button>
      </div>
      <p class="note" data-ref="resNote"></p>
    </div></section>`)
  }

  private buildBoards(): HTMLElement {
    return el(`<div class="modal boards"><div class="panel">
      <h2 class="stroke" data-t="board.title"></h2>
      <div class="tabs"><button class="tab" data-act="tab-day" data-t="board.day"></button><button class="tab" data-act="tab-all" data-t="board.all"></button></div>
      <div class="board-meta" data-ref="boardMeta"></div>
      <ol class="board-list" data-ref="boardList"></ol>
      <div class="board-me" data-ref="boardMe"></div>
      <button class="btn ghost" data-act="close" data-t="common.close"></button>
    </div></div>`)
  }

  private buildSettings(): HTMLElement {
    const node = el(`<div class="modal settings"><div class="panel">
      <h2 class="stroke" data-t="settings.title"></h2>
      <label class="set"><span data-t="settings.music"></span><input type="range" min="0" max="1" step="0.05" data-set="musicVolume" /></label>
      <label class="set"><span data-t="settings.sfx"></span><input type="range" min="0" max="1" step="0.05" data-set="sfxVolume" /></label>
      <label class="set check"><span data-t="settings.mute"></span><input type="checkbox" data-set="muted" /></label>
      <div class="set"><span data-t="settings.quality"></span><div class="seg">
        <button data-q="low" data-t="settings.low"></button><button data-q="medium" data-t="settings.medium"></button><button data-q="high" data-t="settings.high"></button></div></div>
      <label class="set check"><span data-t="settings.motion"></span><input type="checkbox" data-set="reducedMotion" /></label>
      <div class="set"><span data-t="settings.language"></span><div class="seg"><button data-l="mn">Монгол</button><button data-l="zh-CN">中文</button><button data-l="en">English</button></div></div>
      <button class="btn primary" data-act="close" data-t="common.close"></button>
    </div></div>`)
    node.addEventListener('input', e => {
      const t = e.target as HTMLInputElement
      const key = t.dataset.set as keyof SaveData | undefined
      if (!key) return
      this.actions.settings({ [key]: t.type === 'checkbox' ? t.checked : Number(t.value) } as Partial<SaveData>)
    })
    node.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest('button')
      if (b?.dataset.q) this.actions.settings({ quality: b.dataset.q as Quality })
      if (b?.dataset.l) this.actions.settings({ locale: b.dataset.l as Locale })
      this.refreshSettings()
    })
    return node
  }

  private buildRoute(): HTMLElement {
    const maps = Object.values(MAPS).map(m => `<button class="route-card" data-act="map" data-map="${m.id}"><b data-t="${m.nameKey}"></b><small data-t="${m.descKey}"></small></button>`).join('')
    const weather: WeatherSelection[] = ['auto', 'night', 'rain', 'dusk', 'fog', 'dawn']
    const skies = weather.map(id => {
      const name = id === 'auto' ? 'weather.auto' : `cond.${id}`
      const desc = id === 'auto' ? 'weather.auto.d' : `cond.${id}.d`
      return `<button class="route-card weather-card" data-act="weather" data-weather="${id}"><b data-t="${name}"></b><small data-t="${desc}"></small></button>`
    }).join('')
    return el(`<div class="modal route"><div class="panel wide">
      <h2 class="stroke" data-t="route.title"></h2>
      <h3 data-t="route.maps"></h3><div class="route-grid">${maps}</div>
      <h3 data-t="route.weather"></h3><div class="route-grid">${skies}</div>
      <button class="btn ghost" data-act="close" data-t="common.close"></button>
    </div></div>`)
  }

  private buildTouch(): HTMLElement {
    const node = el(`<div class="touch">
      <div class="t-left"><button data-c="left">◀</button><button data-c="right">▶</button></div>
      <div class="t-right"><button data-c="handbrake" class="hb" data-t="touch.hb"></button><button data-c="brake" class="brake" data-t="touch.brake"></button><button data-c="throttle" class="gas" data-t="touch.gas"></button></div>
      <button class="t-reset" data-reset>⟲</button>
    </div>`)
    const active = new Map<number, TouchControl>()
    const release = (id: number) => {
      const c = active.get(id)
      if (c) {
        this.input.setTouch(c, false)
        node.querySelector(`[data-c="${c}"]`)?.classList.remove('on')
      }
      active.delete(id)
    }
    node.addEventListener('pointerdown', e => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-c]')
      if ((e.target as HTMLElement).closest('[data-reset]')) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' }))
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }))
        return
      }
      if (!b) return
      e.preventDefault()
      const c = b.dataset.c as TouchControl
      active.set(e.pointerId, c)
      b.classList.add('on')
      b.setPointerCapture?.(e.pointerId)
      this.input.setTouch(c, true)
      this.audio.unlock()
    })
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) node.addEventListener(type, e => release((e as PointerEvent).pointerId))
    node.addEventListener('contextmenu', e => e.preventDefault())
    return node
  }

  setTouchActive(on: boolean): void {
    this.touchActive = on
    this.root.classList.toggle('touch-on', on)
    if (this.hintKey) this.hint(this.hintKey)
  }

  // ─── localization ─────────────────────────────────────────────────────
  private ref<T extends HTMLElement = HTMLElement>(scope: HTMLElement, name: string): T {
    return scope.querySelector<T>(`[data-ref="${name}"]`)!
  }

  private relocalize(): void {
    const t = (k: string, v?: Record<string, string | number>) => this.i18n.t(k, v)
    this.root.querySelectorAll<HTMLElement>('[data-t]').forEach(n => (n.textContent = t(n.dataset.t!)))
    const title = this.screens.title
    const c = this.daily.condition.id
    this.ref(title, 'cond').textContent = t(`cond.${c}`)
    this.ref(title, 'condD').textContent = t(`cond.${c}.d`)
    this.ref(title, 'day').textContent = this.daily.day
    title.dataset.cond = c
    this.refreshTitle()
    if (this.target) {
      const vs = this.ref(title, 'vs')
      vs.hidden = false
      this.ref(vs, 'vsName').textContent = t('title.target', { name: this.target.name })
      this.ref(vs, 'vsScore').textContent = t('title.targetScore', { score: fmt(this.target.score) })
    }
    if (this.endRun) this.renderResults()
    if (this.hintKey) this.hint(this.hintKey)
    this.refreshSettings()
    this.refreshRoute()
  }

  refreshTitle(): void {
    const best = this.save.data.best
    this.ref(this.screens.title, 'best').innerHTML = best > 0 ? `<span>${esc(this.i18n.t('hud.best'))}</span><b>${fmt(best)}</b>` : `<span>${esc(this.i18n.t('title.noBest'))}</span>`
  }

  refreshSettings(): void {
    const d = this.save.data
    const s = this.modals.settings
    s.querySelectorAll<HTMLInputElement>('[data-set]').forEach(i => {
      const v = d[i.dataset.set as keyof SaveData]
      if (i.type === 'checkbox') i.checked = v === true
      else i.value = String(v)
    })
    s.querySelectorAll<HTMLElement>('[data-q]').forEach(b => b.classList.toggle('on', b.dataset.q === d.quality))
    s.querySelectorAll<HTMLElement>('[data-l]').forEach(b => b.classList.toggle('on', b.dataset.l === this.i18n.locale))
  }

  refreshRoute(): void {
    const r = this.modals.route
    r.querySelectorAll<HTMLElement>('[data-map]').forEach(b => b.classList.toggle('on', b.dataset.map === this.save.data.mapId))
    r.querySelectorAll<HTMLElement>('[data-weather]').forEach(b => b.classList.toggle('on', b.dataset.weather === this.save.data.weatherId))
  }

  // ─── screens ──────────────────────────────────────────────────────────
  show(screen: Screen): void {
    this.screen = screen
    for (const [name, node] of Object.entries(this.screens)) node.classList.toggle('on', name === screen)
    this.root.dataset.screen = screen
    if (screen === 'title') this.refreshTitle()
    if (screen === 'hud') {
      this.lastScore = -1
      this.lastSeg = -1
      this.pbToasted = this.targetToasted = this.lastTenToasted = false
      this.popups.innerHTML = ''
      this.toastEl.innerHTML = ''
      this.endRun = undefined
      const tb = this.ref(this.screens.hud, 'targetBox')
      tb.hidden = !this.target
      if (this.target) this.ref(tb, 'targetLabel').textContent = `${this.i18n.t('hud.target')} ${fmt(this.target.score)} · ${this.target.name}`
      const best = this.save.data.best
      this.ref(this.screens.hud, 'bestLine').textContent = best > 0 ? `${this.i18n.t('hud.best')} ${fmt(best)}` : ''
    }
    if (screen !== 'hud') this.hint(null)
    if (screen === 'results') this.resultsAt = performance.now()
  }

  openModal(m: Exclude<Modal, null>): void {
    this.closeModal()
    this.modal = m
    this.modals[m].classList.add('on')
    if (m === 'boards') void this.loadBoard(this.boardScope)
    if (m === 'settings') this.refreshSettings()
    if (m === 'route') this.refreshRoute()
  }

  closeModal(): void {
    if (!this.modal) return
    this.modals[this.modal].classList.remove('on')
    this.modal = null
  }

  /** Space/Enter/Ⓐ may restart only after the results have been visible briefly. */
  get canQuickRestart(): boolean {
    return this.screen === 'results' && !this.modal && performance.now() - this.resultsAt > 700 && !(document.activeElement instanceof HTMLInputElement)
  }

  setBootProgress(p: number): void {
    const bar = this.screens.boot.querySelector<HTMLElement>('.bar i')
    if (bar) bar.style.width = `${Math.round(p * 100)}%`
  }

  private onClick(e: Event): void {
    const target = e.target as HTMLElement
    const b = target.closest<HTMLElement>('[data-act]')
    if (!b) {
      if (target.classList.contains('modal')) this.closeModal()
      return
    }
    const act = b.dataset.act!
    if (act !== 'download') this.audio.play('ui')
    switch (act) {
      case 'play': this.actions.play(); break
      case 'restart': this.closeModal(); this.actions.restart(); break
      case 'resume': this.actions.resume(); break
      case 'quit': this.closeModal(); this.actions.quit(); break
      case 'pause': window.dispatchEvent(new Event('game:pause')); break
      case 'boards': this.openModal('boards'); break
      case 'route': this.openModal('route'); break
      case 'settings': this.openModal('settings'); break
      case 'map': this.closeModal(); this.actions.settings({ mapId: b.dataset.map as MapId }); break
      case 'weather': this.closeModal(); this.actions.settings({ weatherId: b.dataset.weather as WeatherSelection }); break
      case 'close': this.closeModal(); break
      case 'lang': {
        const next: Locale = this.i18n.locale === 'en' ? 'mn' : this.i18n.locale === 'mn' ? 'zh-CN' : 'en'
        this.actions.settings({ locale: next })
        break
      }
      case 'tab-day': void this.loadBoard('day'); break
      case 'tab-all': void this.loadBoard('all'); break
      case 'submit': {
        const input = this.screens.results.querySelector<HTMLInputElement>('input.name')
        if (input) this.actions.submitName(input.value)
        break
      }
      case 'retry': this.actions.retrySubmit(); break
      case 'copyLink':
      case 'copyLink2':
        void this.actions.copyLink().then(ok => this.note(ok ? this.i18n.t('end.copied') : '', act === 'copyLink2'))
        break
      case 'share': void this.openShare(); break
      case 'system': void this.actions.shareSystem(this.shareBlob); break
      case 'copyImg': void this.actions.copyImage(this.shareBlob).then(ok => ok && this.note(this.i18n.t('share.imgCopied'), true)); break
    }
  }

  private note(text: string, inShare = false): void {
    const n = inShare ? this.ref(this.modals.share, 'shareNote') : this.ref(this.screens.results, 'resNote')
    n.textContent = text
    n.classList.remove('flash')
    void n.offsetWidth
    n.classList.add('flash')
  }

  private async openShare(): Promise<void> {
    const res = await this.actions.shareCard()
    if (!res) return
    this.shareBlob = res.blob
    if (this.shareUrl) URL.revokeObjectURL(this.shareUrl)
    this.shareUrl = res.url
    const m = this.modals.share
    m.querySelector('img')!.src = res.url
    m.querySelector<HTMLAnchorElement>('[data-act="download"]')!.href = res.url
    const sys = m.querySelector<HTMLElement>('[data-act="system"]')!
    sys.hidden = typeof navigator.share !== 'function'
    const copy = m.querySelector<HTMLElement>('[data-act="copyImg"]')!
    copy.hidden = typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write
    this.ref(m, 'shareNote').textContent = ''
    this.openModal('share')
  }

  private async loadBoard(scope: Scope): Promise<void> {
    this.boardScope = scope
    const m = this.modals.boards
    m.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.getAttribute('data-act') === `tab-${scope}`))
    const list = this.ref(m, 'boardList')
    const meta = this.ref(m, 'boardMeta')
    const me = this.ref(m, 'boardMe')
    list.innerHTML = `<li class="empty">${esc(this.i18n.t('online.loading'))}</li>`
    meta.textContent = scope === 'day' ? `${this.i18n.t(`cond.${this.daily.condition.id}`)} · ${this.daily.day}` : ''
    me.textContent = ''
    try {
      const view = await this.actions.loadBoard(scope)
      if (this.boardScope !== scope) return
      meta.textContent = `${scope === 'day' ? `${this.i18n.t(`cond.${this.daily.condition.id}`)} · ${this.daily.day} · ` : ''}${this.i18n.t('board.total', { n: view.total })}`
      list.innerHTML = view.entries.length
        ? view.entries.map(e => `<li class="${e.me ? 'me' : ''} r${e.rank}"><span class="rk">${e.rank}</span><span class="nm">${esc(e.displayName)}${e.me ? ` <em>${esc(this.i18n.t('board.you'))}</em>` : ''}</span><span class="sc">${fmt(e.score)}</span></li>`).join('')
        : `<li class="empty">${esc(this.i18n.t('online.empty'))}</li>`
      if (view.myRank && !view.entries.some(e => e.me)) me.textContent = this.i18n.t('board.yourRank', { rank: view.myRank.rank, score: fmt(view.myRank.score) })
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'offline'
      list.innerHTML = `<li class="empty">${esc(this.i18n.t(`online.${code}`))}</li>`
    }
  }

  // ─── in-run feedback ───────────────────────────────────────────────────
  hint(h: Hint): void {
    this.hintKey = h
    if (!h || this.screen !== 'hud') {
      this.hintEl.classList.remove('on')
      return
    }
    const touchKey = `hint.${h}.touch`
    const key = this.touchActive && this.i18n.t(touchKey) !== touchKey ? touchKey : `hint.${h}`
    this.hintEl.textContent = this.i18n.t(key)
    this.hintEl.dataset.kind = h
    this.hintEl.classList.add('on')
  }

  toast(text: string, kind = ''): void {
    const n = el(`<div class="toast ${kind}">${esc(text)}</div>`)
    this.toastEl.append(n)
    window.setTimeout(() => n.remove(), 2200)
    while (this.toastEl.children.length > 3) this.toastEl.firstElementChild?.remove()
  }

  popup(text: string, at: { x: number; y: number }, kind: string, big = false): void {
    const n = el(`<div class="pop ${kind}${big ? ' big' : ''}">${esc(text)}</div>`)
    n.style.left = `${Math.max(80, Math.min(window.innerWidth - 80, at.x))}px`
    n.style.top = `${Math.max(90, Math.min(window.innerHeight - 140, at.y))}px`
    this.popups.append(n)
    window.setTimeout(() => n.remove(), big ? 1700 : 1200)
    while (this.popups.children.length > 8) this.popups.firstElementChild?.remove()
  }

  event(e: DriftEvent, at: { x: number; y: number }): void {
    const t = (k: string, v?: Record<string, string | number>) => this.i18n.t(k, v)
    const mid = { x: window.innerWidth / 2, y: window.innerHeight * 0.42 }
    switch (e.type) {
      case 'start': this.popup(t('pop.go'), mid, 'go', true); break
      case 'clip': this.popup(t('pop.clip', { n: fmt(e.bonus) }), { x: at.x, y: at.y - 40 }, 'clip'); break
      case 'nearMiss': this.popup(t('pop.near', { n: fmt(e.bonus) }), { x: at.x, y: at.y - 70 }, 'near'); break
      case 'lost':
        if (e.points > 0) this.popup(t(e.reason === 'crash' ? 'pop.crash' : 'pop.spin', { n: fmt(e.points) }), { x: mid.x, y: mid.y + 60 }, 'lost', true)
        this.flash('lost')
        break
      case 'bank':
        if (e.rating > 0) this.popup(`${t(`rating.${e.rating}`)}  +${fmt(e.points)}`, { x: mid.x, y: mid.y + 40 }, `bank r${e.rating}`, true)
        else this.popup(`+${fmt(e.points)}`, { x: mid.x, y: mid.y + 60 }, 'bank r0')
        break
      case 'heat': this.toast(t(`heat.${e.heat}`), `heat h${e.heat}`); break
    }
  }

  private flash(kind: string): void {
    const hud = this.screens.hud
    hud.classList.remove(`flash-${kind}`)
    void hud.offsetWidth
    hud.classList.add(`flash-${kind}`)
  }

  updateHud(s: HudState): void {
    const hud = this.screens.hud
    const run = s.run
    if (run.score !== this.lastScore) {
      const v = this.ref(hud, 'score')
      v.textContent = fmt(run.score)
      if (this.lastScore >= 0) {
        v.classList.remove('bump')
        void v.offsetWidth
        v.classList.add('bump')
      }
      this.lastScore = run.score
      const best = this.save.data.best
      if (!this.pbToasted && best > 0 && run.score > best) {
        this.pbToasted = true
        this.toast(this.i18n.t('toast.pb'), 'pb')
        this.audio.play('best')
      }
      if (this.target && !this.targetToasted && run.score > this.target.score) {
        this.targetToasted = true
        this.toast(this.i18n.t('toast.target', { name: this.target.name }), 'pb')
      }
    }
    if (this.target) {
      const live = run.score + s.segmentValue
      this.ref<HTMLElement>(hud, 'targetFill').style.width = `${Math.min(100, (live / this.target.score) * 100)}%`
    }
    const time = this.ref(hud, 'time')
    time.textContent = run.phase === 'ready' ? '60' : formatClock(run.timeLeft)
    hud.classList.toggle('last10', run.phase === 'playing' && run.timeLeft <= 10)
    if (run.phase === 'playing' && run.timeLeft <= 10 && !this.lastTenToasted) {
      this.lastTenToasted = true
      this.toast(this.i18n.t('toast.last'), 'warn')
    }
    const heat = this.ref(hud, 'heat')
    heat.textContent = run.heat > 0 ? ['', '×1.5', '×2', '×3'][run.heat] : ''
    heat.dataset.h = String(run.heat)
    this.ref(hud, 'speed').textContent = String(Math.round(s.speed * 3.6))
    const drift = this.ref(hud, 'drift')
    const active = run.seg.active
    drift.classList.toggle('on', active)
    if (active) {
      if (s.segmentValue !== this.lastSeg) {
        this.ref(drift, 'seg').textContent = fmt(s.segmentValue)
        this.lastSeg = s.segmentValue
      }
      const mult = this.ref(drift, 'mult')
      if (run.seg.mult !== this.lastMult) {
        mult.textContent = `×${run.seg.mult}`
        mult.classList.remove('bump')
        void mult.offsetWidth
        mult.classList.add('bump')
        this.lastMult = run.seg.mult
      }
      mult.dataset.m = String(Math.min(10, run.seg.mult))
      this.ref(drift, 'angle').textContent = `${Math.round(Math.abs(s.slip))}°`
      this.ref(drift, 'clipTag').classList.toggle('on', s.inClip && s.drifting)
      this.ref(drift, 'hold').classList.toggle('on', !run.seg.drifting)
      const graceMax = [1.35, 1.15, 0.95, 0.8][run.heat]
      this.ref<HTMLElement>(drift, 'grace').style.width = `${run.seg.drifting ? 100 : Math.max(0, (run.seg.grace / graceMax) * 100)}%`
    } else {
      this.lastSeg = -1
      this.lastMult = 1
    }
    const wall = this.ref(hud, 'wall')
    wall.classList.toggle('on', active && s.wallGap < 1.2 && s.speed > 8)
  }

  // ─── results ───────────────────────────────────────────────────────────
  showResults(run: RunState, newBest: boolean): void {
    this.endRun = run
    this.endNewBest = newBest
    this.countUp = { from: 0, to: run.score, t: 0 }
    this.renderResults()
    this.show('results')
    this.ref(this.screens.results, 'resNote').textContent = ''
  }

  setOnline(status: OnlineStatus): void {
    this.online = status
    if (this.endRun) this.renderOnline()
  }

  private renderResults(): void {
    const run = this.endRun
    if (!run) return
    const r = this.screens.results
    const t = (k: string, v?: Record<string, string | number>) => this.i18n.t(k, v)
    const stamp = this.ref(r, 'resStamp')
    stamp.textContent = this.endNewBest && run.score > 0 ? t('end.newBest') : run.stats.bestRating > 0 ? t(`rating.${run.stats.bestRating}`) : ''
    stamp.className = `stamp ${this.endNewBest && run.score > 0 ? 'pb' : `r${run.stats.bestRating}`}`
    this.ref(r, 'resBest').textContent = run.score === 0 ? t('end.zero') : t('end.best', { score: fmt(this.save.data.best) })
    const tgt = this.ref(r, 'resTarget')
    if (this.target) {
      const win = run.score > this.target.score
      tgt.textContent = win ? t('end.targetWin', { name: this.target.name, score: fmt(this.target.score) }) : t('end.targetLose', { name: this.target.name, diff: fmt(this.target.score - run.score) })
      tgt.className = `res-target ${win ? 'win' : 'lose'}`
    } else tgt.textContent = ''
    this.ref(r, 'resStats').innerHTML = [
      [t('end.bestSeg'), fmt(run.stats.bestSegment)],
      [t('end.mult'), `×${run.stats.maxMult}`],
      [t('end.clips'), String(run.stats.clips)],
      [t('end.near'), String(run.stats.nearMisses)],
    ].map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')
    this.renderOnline()
  }

  private renderOnline(): void {
    const box = this.ref(this.screens.results, 'resOnline')
    const t = (k: string, v?: Record<string, string | number>) => this.i18n.t(k, v)
    const s = this.online
    box.dataset.kind = s.kind
    if (s.kind === 'none') {
      box.innerHTML = ''
      return
    }
    if (s.kind === 'needName' || (s.kind === 'error' && s.code === 'name')) {
      const existing = box.querySelector<HTMLInputElement>('input.name')
      const value = existing?.value ?? this.save.data.playerName
      box.innerHTML = `<div class="label">${esc(t('end.name'))}</div>
        <div class="name-row"><input class="name" maxlength="16" autocomplete="nickname" enterkeyhint="done" placeholder="${esc(t('end.namePh'))}" value="${esc(value)}" />
        <button class="btn primary" data-act="submit">${esc(t('end.submit'))}</button></div>
        ${s.kind === 'error' ? `<p class="err">${esc(t('online.name'))}</p>` : ''}`
      const input = box.querySelector<HTMLInputElement>('input.name')!
      input.addEventListener('keydown', e => {
        e.stopPropagation()
        if (e.key === 'Enter') this.actions.submitName(input.value)
      })
      return
    }
    if (s.kind === 'posting') {
      box.innerHTML = `<div class="posting">${esc(t('end.submitting'))}</div>`
      return
    }
    if (s.kind === 'error') {
      box.innerHTML = `<p class="err">${esc(t(`online.${s.code}`))}</p>${s.retry ? `<button class="btn" data-act="retry">${esc(t('end.retry'))}</button>` : ''}`
      return
    }
    const pct = s.day.total <= 1 ? t('end.first') : t('end.beat', { pct: s.day.pct })
    box.innerHTML = `<div class="ranks">
        <div class="rank day"><span>${esc(t('end.rankDay', { rank: s.day.rank }))}</span><small>${esc(t('end.of', { n: s.day.total }))}</small></div>
        <div class="rank all"><span>${esc(t('end.rankAll', { rank: s.all.rank }))}</span><small>${esc(t('end.of', { n: s.all.total }))}</small></div>
      </div><div class="beat">${esc(pct)}</div><div class="posted">✔ ${esc(t('end.submitted'))} · ${esc(this.save.data.playerName)}</div>`
  }

  frame(dt: number): void {
    if (this.screen === 'results' && this.countUp.t < 1) {
      this.countUp.t = Math.min(1, this.countUp.t + dt / 0.9)
      const k = 1 - Math.pow(1 - this.countUp.t, 3)
      this.ref(this.screens.results, 'resScore').textContent = fmt(this.countUp.from + (this.countUp.to - this.countUp.from) * k)
    }
  }
}
