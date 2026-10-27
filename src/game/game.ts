import * as THREE from 'three'
import type { Audio } from '../engine/audio'
import type { Input } from '../engine/input'
import { Physics } from '../engine/physics'
import type { Renderer } from '../engine/renderer'
import type { Quality } from '../engine/save'
import { Autopilot } from './autopilot'
import { Car, type Controls } from './car'
import { angleDiff, ChaseCamera, ClipZones } from './clips'
import { CONFIG } from './config'
import type { Daily } from './daily'
import { Effects } from './fx'
import { createRun, segmentValue, stepReady, stepRun, type DriftEvent, type RunState } from './rules'
import { SkidMarks, Smoke } from './skid'
import { project, sampleAt } from './track'
import { WALL, World } from './world'

export type Mode = 'attract' | 'playing' | 'paused' | 'ended'
export type Hint = 'go' | 'drift' | 'hold' | 'clip' | 'reset' | 'wrong' | null

export type GameHooks = {
  event(e: DriftEvent, at: { x: number; y: number }): void
  hint(hint: Hint): void
  end(run: RunState): void
}

export type HudState = {
  run: RunState
  speed: number
  slip: number
  drifting: boolean
  segmentValue: number
  inClip: boolean
  wallGap: number
}

const TMP = new THREE.Vector3()

/**
 * One playable scene: owns world, physics, car, camera, clip zones and the run rules, and turns
 * simulation events into audio, particles and UI hooks. `main.ts` drives it from the fixed-step
 * loop; the UI never reaches inside.
 */
export class Game {
  mode: Mode = 'attract'
  run: RunState = createRun()
  reducedMotion = false
  /** Automated balance testing: the autopilot drives during real runs. */
  botPlay = false
  readonly world: World
  private readonly physics: Physics
  private readonly car: Car
  private readonly cam = new ChaseCamera()
  private readonly clips: ClipZones
  private readonly pilot: Autopilot
  private readonly skids = new SkidMarks()
  private readonly smoke = new Smoke()
  private readonly sparks = new Effects()
  private time = 0
  private hintState: Hint = null
  private trackHint = -1
  private crashCooldown = 0
  private contactTime = 0
  private spinCooldown = 0
  private nearCooldown = 0
  private stuck = 0
  private wrongWay = 0
  private taught = { drift: false, hold: false, clip: false }
  private inClip = false
  private wallGap = 10
  private lastTick = -1

  constructor(
    private readonly renderer: Renderer,
    private readonly input: Input,
    private readonly audio: Audio,
    readonly daily: Daily,
    private readonly hooks: GameHooks,
    public tutorial: boolean,
  ) {
    this.physics = new Physics(0)
    this.world = new World(this.physics, renderer.shadowMapSize, daily.mapId)
    this.world.applyCondition(daily.condition, renderer.gl)
    const s = this.world.spawn
    this.car = new Car(this.physics, new THREE.Vector3(s.x, 0, s.z), s.yaw)
    this.car.gripScale = daily.condition.grip
    this.car.setNightLights(daily.condition.lamps)
    this.clips = new ClipZones(daily.clips, this.world.track)
    this.pilot = new Autopilot(this.world.track)
    this.smoke.setColor(daily.condition.rain ? '#c9d3e6' : daily.condition.id === 'dusk' ? '#f1d9d0' : '#dcd6ec')
    this.world.scene.add(this.car.root, this.clips.group, this.skids.mesh, this.smoke.points, this.sparks.mesh)
    // Title backdrop: the attract drive starts a little way down the straight.
    this.placeCar(10)
  }

  get camera(): THREE.PerspectiveCamera {
    return this.cam.camera
  }

  private placeCar(index: number): void {
    const p = sampleAt(this.world.track, index)
    const yaw = Math.atan2(p.tx, p.tz)
    this.car.teleport(p.x, p.z, yaw)
    this.cam.reset(this.car.pos, yaw)
    this.trackHint = index
  }

  start(): void {
    this.skids.clear()
    this.smoke.clear()
    this.sparks.clear()
    this.clips.reset()
    this.placeCar(0)
    this.pilot.reset()
    this.run = createRun()
    this.mode = 'playing'
    this.crashCooldown = this.spinCooldown = this.nearCooldown = 0
    this.stuck = this.wrongWay = 0
    this.lastTick = -1
    this.input.endFrame()
    this.audio.intensity = 0
    this.hintState = null
    this.setHint('go')
  }

  pause(): void {
    if (this.mode === 'playing') this.mode = 'paused'
  }

  resume(): void {
    if (this.mode !== 'paused') return
    this.mode = 'playing'
    this.input.endFrame()
  }

  toTitle(): void {
    this.mode = 'attract'
    this.setHint(null)
    this.pilot.reset()
    this.audio.intensity = 0
  }

  setQuality(quality: Quality): void {
    this.renderer.applyQuality(quality)
    const size = this.renderer.shadowMapSize
    const shadow = this.world.sun.shadow
    shadow.map?.dispose()
    shadow.map = null
    shadow.mapSize.set(size, size)
    // Shadow support is compiled into shaders: recompile after toggling shadows at runtime.
    this.world.scene.traverse(obj => {
      const material = (obj as THREE.Mesh).material
      for (const m of Array.isArray(material) ? material : material ? [material] : []) m.needsUpdate = true
    })
  }

  private setHint(h: Hint): void {
    if (h === this.hintState) return
    this.hintState = h
    this.hooks.hint(h)
  }

  private controls(dt: number): Controls {
    if (this.mode === 'attract' || (this.mode === 'playing' && this.botPlay)) {
      { const v = this.car.velocity; return this.pilot.drive(this.car.pos.x, this.car.pos.z, this.car.yaw, v.x, v.z, dt) }
    }
    if (this.mode === 'ended') return { throttle: 0, brake: 0.35, steer: 0, handbrake: false }
    return { throttle: this.input.throttle, brake: this.input.brake, steer: this.input.steer, handbrake: this.input.held('handbrake') }
  }

  step(dt: number): void {
    const resetPressed = this.input.consume('reset')
    this.input.consume('handbrake')
    if (this.mode === 'paused') return
    const playing = this.mode === 'playing'
    const ctl = this.controls(dt)
    const events: DriftEvent[] = []
    if (playing && this.run.phase === 'ready') {
      stepReady(this.run, dt, this.botPlay || ctl.throttle > 0.05 || Math.abs(ctl.steer) > 0.1 || ctl.handbrake, events)
    }
    this.car.drive(ctl, dt)
    this.physics.step(dt)
    this.car.afterStep()
    const tel = this.car.telemetry
    const pos = this.car.pos
    const pr = project(this.world.track, { x: pos.x, z: pos.z }, this.trackHint)
    this.trackHint = pr.index
    const sample = this.world.track[pr.index]
    const trackYaw = Math.atan2(sample.tx, sample.tz)
    const rel = angleDiff(trackYaw, this.car.yaw)
    const extent = CONFIG.car.halfWidth * Math.abs(Math.cos(rel)) + CONFIG.car.halfLength * Math.abs(Math.sin(rel))
    this.wallGap = WALL - Math.abs(pr.lateral) - extent
    this.crashCooldown -= dt
    this.spinCooldown -= dt
    this.nearCooldown -= dt
    let crash = false
    // A hard hit, or grinding along the barrier for a moment, both count as hitting the wall.
    this.contactTime = tel.contact ? this.contactTime + dt : 0
    if (tel.contact && (tel.impact > CONFIG.drift.crashDv || this.contactTime > CONFIG.drift.scrapeTime) && this.crashCooldown <= 0) {
      crash = true
      this.crashCooldown = 0.6
      this.onCrash(pr.lateral, sample, tel.impact)
    }
    let spin = false
    if (Math.abs(tel.slip) > CONFIG.drift.spinAngle && tel.speed > 5 && this.spinCooldown <= 0) {
      spin = true
      this.spinCooldown = 1.2
    }
    const clip = this.clips.test(pos.x, pos.z, tel.drifting)
    this.inClip = clip.inside
    let nearMiss = false
    if (tel.drifting && !tel.contact && tel.speed > CONFIG.drift.nearMissSpeed && this.wallGap < CONFIG.drift.nearMiss && this.nearCooldown <= 0) {
      nearMiss = true
      this.nearCooldown = CONFIG.drift.nearMissCooldown
    }
    if (playing && this.run.phase === 'playing') {
      stepRun(this.run, dt, { drifting: tel.drifting, angle: Math.abs(tel.slip), speed: tel.speed, inClip: clip.inside, clipEntered: !!clip.entered, nearMiss, crash, spin }, events)
      this.updateHints(dt, tel.drifting, rel)
      const secs = Math.ceil(this.run.timeLeft)
      if (this.run.timeLeft <= 5 && secs !== this.lastTick && this.run.phase === 'playing') {
        this.lastTick = secs
        this.audio.play('tick')
      }
    }
    // Pinned against a barrier or turned around for a while: rescue automatically (the reset hint shows first).
    const pinned = this.stuck > 3.5 && (this.wallGap < 1.2 || Math.abs(rel) > 1.2)
    if ((resetPressed || pinned) && playing) {
      this.stuck = 0
      this.respawn(pr.index)
    }
    else if (Math.abs(pr.lateral) > WALL + 3) this.respawn(pr.index)
    this.emitTyreFx(tel)
    const at = this.project(TMP.set(pos.x, 1.6, pos.z))
    for (const e of events) this.onEvent(e, at)
  }

  private respawn(index: number): void {
    if (this.run.seg.active && this.run.phase === 'playing') {
      const ev: DriftEvent[] = []
      stepRun(this.run, 0, { drifting: false, angle: 0, speed: 0, inClip: false, clipEntered: false, nearMiss: false, crash: false, spin: true }, ev)
      for (const e of ev) this.onEvent(e, this.project(TMP.copy(this.car.pos).setY(1.6)))
    }
    this.placeCar(index)
    this.skids.lift()
  }

  private updateHints(dt: number, drifting: boolean, rel: number): void {
    const tel = this.car.telemetry
    this.stuck = tel.speed < 1.5 ? this.stuck + dt : 0
    this.wrongWay = Math.abs(rel) > 2.1 && tel.speed > 4 ? this.wrongWay + dt : 0
    const run = this.run
    if (run.stats.segments > 0) this.taught.drift = true
    if (run.stats.clips > 0) this.taught.clip = true
    if (this.hintState === 'hold' && !run.seg.active) this.taught.hold = true
    let hint: Hint = null
    if (this.stuck > 2.2) hint = 'reset'
    else if (this.wrongWay > 1.2) hint = 'wrong'
    else if (this.tutorial) {
      if (!this.taught.drift && !run.seg.active && run.elapsed > 2.5) hint = 'drift'
      else if (run.seg.active && !this.taught.hold && drifting) hint = 'hold'
      else if (this.hintState === 'hold' && run.seg.active) hint = 'hold'
      else if (this.taught.hold && !this.taught.clip && !run.seg.active && run.elapsed < 45) hint = 'clip'
    }
    this.setHint(hint)
  }

  private onCrash(lateral: number, sample: { nx: number; nz: number }, impact: number): void {
    const side = Math.sign(lateral) || 1
    const p = TMP.set(this.car.pos.x + sample.nx * side * 1.4, 0.7, this.car.pos.z + sample.nz * side * 1.4)
    this.sparks.burst(p, '#ffd35c', 26, 9)
    this.sparks.burst(p, '#ff7a45', 14, 6)
    this.cam.addShake(Math.min(1, 0.35 + impact * 0.08))
    this.audio.play('crash', Math.min(1, impact / 10))
  }

  private emitTyreFx(tel: Car['telemetry']): void {
    const slipI = Math.min(1, Math.max(0, (Math.abs(tel.slip) - 8) / 30))
    const burnout = tel.throttle > 0.9 && tel.speed < 9 && tel.speed > 0.3 && this.mode === 'playing' ? 0.6 : 0
    const hb = tel.handbrake && tel.speed > 4 ? 0.7 : 0
    const strength = Math.max(slipI * Math.min(1, tel.speed / 8), burnout, hb, tel.braking && tel.speed > 14 ? 0.35 : 0)
    const rainK = this.daily.condition.rain ? 0.6 : 1
    for (let i = 0; i < 4; i += 1) {
      const rear = i < 2
      const w = this.car.wheelWorld(i, TMP)
      const s = rear ? strength : strength > 0.5 && !burnout ? strength * 0.6 : 0
      this.skids.mark(i, w, s > 0.12 ? (0.25 + s * 0.5) * rainK : 0)
      if (rear && s > 0.15 && Math.random() < s * 1.1) this.smoke.emit(w, this.car.velocity, s)
    }
  }

  private onEvent(e: DriftEvent, at: { x: number; y: number }): void {
    switch (e.type) {
      case 'start': this.audio.play('go'); break
      case 'mult': this.audio.play('mult', e.mult); break
      case 'clip': this.audio.play('clip'); this.sparks.burst(TMP.copy(this.car.pos).setY(0.8), '#39e6ff', 22, 6); break
      case 'nearMiss': this.audio.play('nearMiss'); this.cam.addShake(0.15); break
      case 'bank':
        this.audio.play('bank', e.rating)
        if (e.rating >= 3) this.sparks.burst(TMP.copy(this.car.pos).setY(1.4), '#ffd35c', 20 + e.rating * 6, 8)
        break
      case 'lost': this.audio.play('lost'); break
      case 'heat': this.audio.play('heat'); this.audio.intensity = e.heat; this.clips.setHeat(e.heat); break
      case 'end':
        this.mode = 'ended'
        this.audio.play('end')
        this.setHint(null)
        this.hooks.end(this.run)
        break
    }
    this.hooks.event(e, at)
  }

  render(alpha: number, frameSeconds: number): void {
    this.time += frameSeconds
    const tel = this.car.telemetry
    this.car.render(alpha, frameSeconds, tel.braking || this.mode === 'ended')
    const target = this.car.root.position
    if (this.mode === 'attract') this.cam.orbit(target, this.time)
    else if (this.mode !== 'paused') this.cam.update(target, this.car.root.rotation.y, this.car.velocity, tel.slip, tel.speed, frameSeconds, this.reducedMotion)
    this.clips.animate(frameSeconds)
    this.smoke.update(this.mode === 'paused' ? 0 : frameSeconds)
    this.sparks.update(this.mode === 'paused' ? 0 : frameSeconds)
    this.smoke.setViewport(this.renderer.canvas.clientHeight || window.innerHeight, this.cam.camera.fov)
    this.world.update(frameSeconds, target, this.cam.camera)
    this.audio.drive(this.mode !== 'paused', tel.speed, this.mode === 'attract' ? tel.throttle * 0.4 : tel.throttle, tel.slip, this.daily.condition.rain)
    this.renderer.render(this.world.scene, this.cam.camera)
  }

  hud(): HudState {
    const tel = this.car.telemetry
    return { run: this.run, speed: tel.speed, slip: tel.slip, drifting: tel.drifting, segmentValue: segmentValue(this.run.seg), inClip: this.inClip, wallGap: this.wallGap }
  }

  project(world: THREE.Vector3): { x: number; y: number } {
    const v = world.clone().project(this.cam.camera)
    const canvas = this.renderer.canvas
    return { x: ((v.x + 1) / 2) * canvas.clientWidth, y: ((1 - v.y) / 2) * canvas.clientHeight }
  }
}
