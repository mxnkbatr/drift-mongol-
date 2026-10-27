/**
 * Unified input for driving: keyboard, gamepad (analog triggers + stick) and touch buttons all
 * feed one state. Gameplay reads `throttle`, `brake`, `steer` and `held()/consume()`; it never
 * checks raw keys.
 */
export type Action = 'handbrake' | 'pause' | 'confirm' | 'back' | 'reset' | 'start'
export type InputMethod = 'keyboard' | 'gamepad' | 'touch'
export type TouchControl = 'throttle' | 'brake' | 'left' | 'right' | 'handbrake'

const KEY_BINDINGS: Record<Action, string[]> = {
  handbrake: ['Space', 'ShiftLeft', 'ShiftRight'],
  pause: ['Escape', 'KeyP'],
  confirm: ['Enter', 'NumpadEnter'],
  back: [],
  reset: ['KeyR'],
  start: ['Space', 'Enter', 'NumpadEnter'],
}
const DRIVE_KEYS = { throttle: ['KeyW', 'ArrowUp'], brake: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'] }
// Standard gamepad mapping: A=0, B=1, X=2, Y=3, LB=4, RB=5, LT=6, RT=7, Back=8, Start=9, D-pad 12-15.
const PAD_BINDINGS: Record<Action, number[]> = { handbrake: [0, 2, 5], pause: [9], confirm: [0], back: [1], reset: [3, 8], start: [0, 9] }

export class Input {
  /** 0..1 */
  throttle = 0
  /** 0..1 (brake, then reverse when stopped). */
  brake = 0
  /** -1 (left) .. 1 (right). */
  steer = 0
  /** Menu navigation intent: x = right, y = up. */
  readonly move = { x: 0, y: 0 }
  method: InputMethod = 'keyboard'
  private keys = new Set<string>()
  private held_ = new Set<Action>()
  private pressed_ = new Set<Action>()
  private touch = new Set<TouchControl>()
  private padPrev = new Set<Action>()
  private listeners: Array<() => void> = []

  constructor() {
    const on = <K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void) => {
      window.addEventListener(type, fn as EventListener)
      this.listeners.push(() => window.removeEventListener(type, fn as EventListener))
    }
    on('keydown', e => {
      const typing = (e.target as HTMLElement | null)?.matches?.('input, textarea')
      if (typing) return
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
      if (e.repeat) return
      this.keys.add(e.code)
      this.method = 'keyboard'
      for (const [action, codes] of Object.entries(KEY_BINDINGS) as [Action, string[]][]) {
        if (codes.includes(e.code)) this.pressed_.add(action)
      }
    })
    on('keyup', e => this.keys.delete(e.code))
    on('blur', () => {
      this.keys.clear()
      this.touch.clear()
    })
  }

  setTouch(control: TouchControl, down: boolean): void {
    this.method = 'touch'
    if (down) {
      if (control === 'handbrake' && !this.touch.has(control)) this.pressed_.add('handbrake')
      this.touch.add(control)
    } else this.touch.delete(control)
  }

  /** Any driving intent this frame (used to start the clock on first input). */
  get active(): boolean {
    return this.throttle > 0.05 || this.brake > 0.05 || Math.abs(this.steer) > 0.1 || this.held_.has('handbrake')
  }

  /** Sample continuous sources. Call once per rendered frame before gameplay reads input. */
  update(): void {
    const k = (codes: string[]) => codes.some(code => this.keys.has(code))
    let throttle = k(DRIVE_KEYS.throttle) || this.touch.has('throttle') ? 1 : 0
    let brake = k(DRIVE_KEYS.brake) || this.touch.has('brake') ? 1 : 0
    let steer = (k(DRIVE_KEYS.right) || this.touch.has('right') ? 1 : 0) - (k(DRIVE_KEYS.left) || this.touch.has('left') ? 1 : 0)
    let navY = (k(DRIVE_KEYS.throttle) ? 1 : 0) - (k(DRIVE_KEYS.brake) ? 1 : 0)
    this.held_.clear()
    for (const [action, codes] of Object.entries(KEY_BINDINGS) as [Action, string[]][]) if (k(codes)) this.held_.add(action)
    if (this.touch.has('handbrake')) this.held_.add('handbrake')
    const pads = navigator.getGamepads?.() ?? []
    const pad = [...pads].find(p => p && p.connected)
    if (pad) {
      const dead = (v: number, d = 0.16) => (Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d))
      const lx = dead(pad.axes[0] ?? 0)
      const ly = dead(pad.axes[1] ?? 0)
      const rt = pad.buttons[7]?.value ?? 0
      const lt = pad.buttons[6]?.value ?? 0
      const dl = pad.buttons[14]?.pressed ? 1 : 0
      const dr = pad.buttons[15]?.pressed ? 1 : 0
      const du = pad.buttons[12]?.pressed ? 1 : 0
      const dd = pad.buttons[13]?.pressed ? 1 : 0
      const padActive = lx !== 0 || ly !== 0 || rt > 0.05 || lt > 0.05 || pad.buttons.some(b => b.pressed)
      if (padActive) this.method = 'gamepad'
      if (this.method === 'gamepad') {
        throttle = Math.max(throttle, rt > 0.04 ? rt : 0)
        brake = Math.max(brake, lt > 0.04 ? lt : 0)
        const padSteer = lx !== 0 ? Math.sign(lx) * Math.pow(Math.abs(lx), 1.35) : dr - dl
        if (padSteer !== 0) steer = padSteer
        const padNav = ly !== 0 ? -ly : du - dd
        if (padNav !== 0) navY = padNav
      }
      const now = new Set<Action>()
      for (const [action, buttons] of Object.entries(PAD_BINDINGS) as [Action, number[]][]) {
        if (buttons.some(i => pad.buttons[i]?.pressed)) now.add(action)
      }
      for (const action of now) {
        this.held_.add(action)
        if (!this.padPrev.has(action)) this.pressed_.add(action)
      }
      this.padPrev = now
    }
    this.throttle = throttle
    this.brake = brake
    this.steer = Math.max(-1, Math.min(1, steer))
    this.move.x = this.steer
    this.move.y = navY
  }

  held(action: Action): boolean {
    return this.held_.has(action)
  }

  pressed(action: Action): boolean {
    return this.pressed_.has(action)
  }

  /** Read and clear a press (use inside fixed steps so one press triggers exactly once). */
  consume(action: Action): boolean {
    return this.pressed_.delete(action)
  }

  endFrame(): void {
    this.pressed_.clear()
  }

  dispose(): void {
    for (const off of this.listeners) off()
    this.listeners = []
  }
}
