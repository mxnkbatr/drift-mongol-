import * as THREE from 'three'
import { type Physics, RAPIER } from '../engine/physics'
import { CONFIG } from './config'

const C = CONFIG.car

export type Controls = { throttle: number; brake: number; steer: number; handbrake: boolean }

export type CarTelemetry = {
  speed: number
  /** Signed slip angle in degrees (positive = sliding toward the car's right). */
  slip: number
  drifting: boolean
  /** Wall contact this step and its speed change. */
  contact: boolean
  impact: number
  /** Outward contact point estimate for sparks. */
  handbrake: boolean
  throttle: number
  braking: boolean
}

/** Box with a narrower / shifted top face: the base primitive of the low-poly coupe. */
function taperBox(w: number, h: number, d: number, topX = 1, topZ = 1, shiftZ = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
  const p = g.attributes.position as THREE.BufferAttribute
  for (let i = 0; i < p.count; i += 1) {
    if (p.getY(i) > 0) {
      p.setX(i, p.getX(i) * topX)
      p.setZ(i, p.getZ(i) * topZ + shiftZ)
    }
  }
  g.computeVertexNormals()
  return g
}

/** Soft radial texture shared by glows. */
export function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.Texture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const ctx = c.getContext('2d')!
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  g.addColorStop(0, inner)
  g.addColorStop(1, outer)
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/**
 * The player's car: a Rapier dynamic body (walls resolve physically) whose velocity is driven by
 * an arcade drift model every fixed step, plus the visual rig (body roll, steering wheels, lights).
 */
export class Car {
  readonly root = new THREE.Group()
  readonly body: RAPIER.RigidBody
  readonly collider: RAPIER.Collider
  readonly telemetry: CarTelemetry = { speed: 0, slip: 0, drifting: false, contact: false, impact: 0, handbrake: false, throttle: 0, braking: false }
  gripScale = 1
  private readonly chassis = new THREE.Group()
  private readonly wheels: THREE.Object3D[] = []
  private readonly frontPivots: THREE.Object3D[] = []
  private readonly tailMat: THREE.MeshStandardMaterial
  private readonly headlight: THREE.SpotLight
  private readonly glow: THREE.Mesh
  private steerVisual = 0
  private roll = 0
  private pitch = 0
  private wheelSpin = 0
  private setVel = { x: 0, z: 0 }
  private prevVf = 0
  readonly prevPos = new THREE.Vector3()
  readonly pos = new THREE.Vector3()
  prevYaw = 0
  yaw = 0

  constructor(private readonly physics: Physics, spawn: THREE.Vector3, yaw: number) {
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.x, 0.6, spawn.z)
        .setRotation(quatYaw(yaw))
        .enabledTranslations(true, false, true)
        .enabledRotations(false, true, false)
        .setGravityScale(0)
        .setCcdEnabled(true),
    )
    this.collider = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(C.halfWidth, 0.5, C.halfLength).setFriction(0.15).setRestitution(0.12).setDensity(1.2).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min),
      this.body,
    )
    this.yaw = this.prevYaw = yaw
    this.pos.set(spawn.x, 0, spawn.z)
    this.prevPos.copy(this.pos)

    // ── visual rig ────────────────────────────────────────────────────────
    const paint = new THREE.MeshStandardMaterial({ color: '#d8323d', roughness: 0.3, metalness: 0.45, flatShading: true })
    const dark = new THREE.MeshStandardMaterial({ color: '#081b43', roughness: 0.6, metalness: 0.25, flatShading: true })
    const glass = new THREE.MeshStandardMaterial({ color: '#163b76', roughness: 0.15, metalness: 0.65, flatShading: true, emissive: '#071735' })
    const stripe = new THREE.MeshStandardMaterial({ color: '#e6b65b', roughness: 0.38, metalness: 0.25, flatShading: true })
    const head = new THREE.MeshStandardMaterial({ color: '#ffffff', emissive: '#fff3c9', emissiveIntensity: 2.4 })
    this.tailMat = new THREE.MeshStandardMaterial({ color: '#ff2340', emissive: '#ff1030', emissiveIntensity: 1.2 })
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => {
      const o = new THREE.Mesh(g, m)
      o.position.set(x, y, z)
      o.castShadow = true
      this.chassis.add(o)
      return o
    }
    mesh(taperBox(1.9, 0.46, 4.1, 0.96, 0.97), paint, 0, 0.56, 0)
    mesh(taperBox(1.86, 0.2, 1.5, 0.9, 0.8, -0.1), paint, 0, 0.88, 1.2) // hood bulge
    mesh(taperBox(1.6, 0.5, 2.0, 0.78, 0.62, -0.18), glass, 0, 1.03, -0.3) // cabin
    mesh(taperBox(1.64, 0.06, 1.1, 0.8, 0.9), paint, 0, 1.3, -0.45) // roof
    mesh(new THREE.BoxGeometry(0.36, 0.02, 4.12), stripe, 0.36, 0.8, 0)
    mesh(new THREE.BoxGeometry(0.36, 0.02, 4.12), stripe, -0.36, 0.8, 0)
    mesh(new THREE.BoxGeometry(2.0, 0.12, 0.5), dark, 0, 0.36, 2.02) // splitter
    mesh(new THREE.BoxGeometry(1.95, 0.24, 0.3), dark, 0, 0.42, -2.02) // diffuser
    mesh(new THREE.BoxGeometry(0.12, 0.34, 0.12), dark, 0.6, 1.0, -1.8)
    mesh(new THREE.BoxGeometry(0.12, 0.34, 0.12), dark, -0.6, 1.0, -1.8)
    mesh(taperBox(2.05, 0.08, 0.5, 1, 0.8), dark, 0, 1.2, -1.85) // wing
    mesh(new THREE.BoxGeometry(0.5, 0.12, 0.06), head, 0.62, 0.66, 2.06)
    mesh(new THREE.BoxGeometry(0.5, 0.12, 0.06), head, -0.62, 0.66, 2.06)
    mesh(new THREE.BoxGeometry(0.62, 0.1, 0.06), this.tailMat, 0.6, 0.7, -2.06)
    mesh(new THREE.BoxGeometry(0.62, 0.1, 0.06), this.tailMat, -0.6, 0.7, -2.06)
    mesh(new THREE.BoxGeometry(0.1, 0.18, 1.8), dark, 0.97, 0.42, 0) // side skirts
    mesh(new THREE.BoxGeometry(0.1, 0.18, 1.8), dark, -0.97, 0.42, 0)
    // Gold knotwork-inspired side livery and a small horse crest on the hood.
    mesh(new THREE.BoxGeometry(0.045, 0.2, 0.72), stripe, 0.985, 0.72, 0.18)
    mesh(new THREE.BoxGeometry(0.045, 0.2, 0.72), stripe, -0.985, 0.72, 0.18)
    mesh(new THREE.BoxGeometry(0.38, 0.045, 0.62), stripe, 0, 0.925, 1.22)
    this.root.add(this.chassis)

    const tire = new THREE.MeshStandardMaterial({ color: '#15131f', roughness: 0.9, flatShading: true })
    const rim = new THREE.MeshStandardMaterial({ color: '#d8dcef', roughness: 0.3, metalness: 0.7, flatShading: true })
    const tireGeo = new THREE.CylinderGeometry(0.36, 0.36, 0.3, 10).rotateZ(Math.PI / 2)
    const rimGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.32, 6).rotateZ(Math.PI / 2)
    for (const [x, z] of [[0.86, 1.3], [-0.86, 1.3], [0.86, -1.3], [-0.86, -1.3]]) {
      const pivot = new THREE.Group()
      pivot.position.set(x, 0.36, z)
      const wheel = new THREE.Group()
      const t = new THREE.Mesh(tireGeo, tire)
      t.castShadow = true
      wheel.add(t, new THREE.Mesh(rimGeo, rim))
      pivot.add(wheel)
      this.root.add(pivot)
      this.wheels.push(wheel)
      if (z > 0) this.frontPivots.push(pivot)
    }
    // Underglow: a soft additive decal that reads well at night and in bloom.
    this.glow = new THREE.Mesh(
      new THREE.PlaneGeometry(3.6, 6.2).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: radialTexture('rgba(90,240,255,0.9)', 'rgba(90,240,255,0)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }),
    )
    this.glow.position.y = 0.05
    this.root.add(this.glow)
    this.headlight = new THREE.SpotLight('#fff1d0', 60, 70, 0.55, 0.55, 1.1)
    this.headlight.position.set(0, 0.8, 1.6)
    this.headlight.target.position.set(0, 0, 14)
    this.root.add(this.headlight, this.headlight.target)
  }

  setNightLights(level: number): void {
    this.headlight.intensity = 25 + level * 45
    ;(this.glow.material as THREE.MeshBasicMaterial).opacity = 0.35 + level * 0.5
  }

  teleport(x: number, z: number, yaw: number): void {
    this.body.setTranslation({ x, y: 0.6, z }, true)
    this.body.setRotation(quatYaw(yaw), true)
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true)
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true)
    this.yaw = this.prevYaw = yaw
    this.pos.set(x, 0, z)
    this.prevPos.copy(this.pos)
    this.setVel = { x: 0, z: 0 }
    this.prevVf = 0
    this.roll = this.pitch = 0
  }

  /** Apply the arcade model: call before `physics.step()`. */
  drive(ctl: Controls, dt: number): void {
    const t = this.body.translation()
    this.prevPos.copy(this.pos)
    this.prevYaw = this.yaw
    this.pos.set(t.x, 0, t.z)
    this.yaw = yawOf(this.body.rotation())
    const fx = Math.sin(this.yaw)
    const fz = Math.cos(this.yaw)
    const rx = -fz
    const rz = fx
    const v = this.body.linvel()
    let vf = v.x * fx + v.z * fz
    let vr = v.x * rx + v.z * rz
    const speed = Math.hypot(vf, vr)
    const slipRad = speed > 1.5 ? Math.atan2(vr, Math.abs(vf)) : 0
    const slipDeg = (slipRad * 180) / Math.PI
    const sliding = Math.abs(slipDeg) > CONFIG.drift.minAngle * 0.75 && speed > CONFIG.drift.minSpeed * 0.8
    const throttle = ctl.throttle
    // ── lateral grip ─────────────────────────────────────────────────────
    let grip: number = C.grip
    if (ctl.handbrake) grip = C.handbrakeGrip
    else if (sliding) grip = throttle > 0.2 ? C.driftGrip : C.driftGrip * 1.9
    if (ctl.brake > 0.3 && Math.abs(ctl.steer) > 0.3 && vf > 12) grip = Math.min(grip, C.grip * 0.45)
    grip *= this.gripScale
    const keep = Math.exp(-grip * dt)
    const lost = vr * (1 - keep)
    vr *= keep
    // A slide converts part of its lateral momentum into forward speed instead of just scrubbing it.
    const transfer = throttle > 0.2 ? C.driftPush : 0.3
    if (vf > 0) vf += Math.abs(lost) * transfer
    // ── longitudinal ─────────────────────────────────────────────────────
    if (throttle > 0) {
      const boost = C.launchBoost * Math.max(0, 1 - Math.max(0, vf) / 16)
      vf += (C.engineForce + boost) * throttle * Math.max(0, 1 - vf / C.maxSpeed) * dt
    }
    if (ctl.brake > 0) {
      if (vf > 0.6) vf -= C.brakeForce * ctl.brake * dt
      else vf = Math.max(-C.reverseSpeed, vf - 12 * ctl.brake * dt)
    }
    if (ctl.handbrake && vf > 0) vf -= 5 * dt
    vf -= C.drag * vf * Math.abs(vf) * dt
    if (throttle === 0 && ctl.brake === 0) vf -= Math.sign(vf) * Math.min(Math.abs(vf), C.rolling * dt)
    if (vf > C.maxSpeed) vf = C.maxSpeed
    // ── yaw ──────────────────────────────────────────────────────────────
    const moving = Math.min(1, speed / 6)
    const dir = vf < -0.5 ? -1 : 1
    const rate = sliding || ctl.handbrake ? C.driftSteerRate / (1 + speed / 30) : C.steerRate / (1 + speed / 14)
    let targetYaw = -ctl.steer * rate * moving * dir
    if (ctl.handbrake && speed > 6) targetYaw += -ctl.steer * C.handbrakeKick * moving
    if (sliding && Math.abs(ctl.steer) < 0.15) targetYaw += -C.assist * slipRad
    const w = this.body.angvel().y
    const response = sliding ? C.yawResponse * 0.55 : C.yawResponse
    const newW = w + (targetYaw - w) * (1 - Math.exp(-response * dt))
    const nvx = fx * vf + rx * vr
    const nvz = fz * vf + rz * vr
    this.body.setLinvel({ x: nvx, y: 0, z: nvz }, true)
    this.body.setAngvel({ x: 0, y: newW, z: 0 }, true)
    this.setVel = { x: nvx, z: nvz }
    const tel = this.telemetry
    tel.speed = speed
    tel.slip = slipDeg
    tel.drifting = Math.abs(slipDeg) > CONFIG.drift.minAngle && speed > CONFIG.drift.minSpeed && vf > 0
    tel.handbrake = ctl.handbrake
    tel.throttle = throttle
    tel.braking = ctl.brake > 0.1 && vf > 0.5
    // Visual state for body roll / pitch.
    const accel = (vf - this.prevVf) / dt
    this.prevVf = vf
    this.pitch += (THREE.MathUtils.clamp(-accel * 0.004, -0.05, 0.05) - this.pitch) * 0.15
    this.roll += (THREE.MathUtils.clamp(newW * speed * 0.0022, -0.09, 0.09) - this.roll) * 0.15
    this.steerVisual += (ctl.steer * -0.5 - this.steerVisual) * 0.3
  }

  /** Read back wall response: call after `physics.step()`. */
  afterStep(): void {
    const v = this.body.linvel()
    const dv = Math.hypot(v.x - this.setVel.x, v.z - this.setVel.z)
    let contact = false
    this.physics.world.contactPairsWith(this.collider, other => {
      if (contact) return
      this.physics.world.contactPair(this.collider, other, manifold => {
        if (manifold.numSolverContacts() > 0) contact = true
      })
    })
    this.telemetry.contact = contact
    this.telemetry.impact = contact ? dv : 0
    const t = this.body.translation()
    if (Math.abs(t.y - 0.6) > 0.01) this.body.setTranslation({ x: t.x, y: 0.6, z: t.z }, false)
  }

  /** Interpolated render transform + cosmetic animation. */
  render(alpha: number, frameSeconds: number, braking: boolean): void {
    this.root.position.lerpVectors(this.prevPos, this.pos, alpha)
    let dy = this.yaw - this.prevYaw
    dy = Math.atan2(Math.sin(dy), Math.cos(dy))
    this.root.rotation.set(0, this.prevYaw + dy * alpha, 0)
    this.chassis.rotation.set(this.pitch, 0, this.roll)
    this.chassis.position.y = Math.abs(this.roll) * 0.4
    this.wheelSpin += (this.prevVf / 0.36) * frameSeconds
    for (const w of this.wheels) w.rotation.x = this.wheelSpin
    for (const p of this.frontPivots) p.rotation.y = this.steerVisual
    this.tailMat.emissiveIntensity = braking ? 4.5 : 1.2
  }

  /** World positions of the rear (0,1) and front (2,3) contact patches. */
  wheelWorld(i: number, out: THREE.Vector3): THREE.Vector3 {
    const lx = i % 2 === 0 ? 0.86 : -0.86
    const lz = i < 2 ? -1.3 : 1.3
    const s = Math.sin(this.yaw)
    const c = Math.cos(this.yaw)
    return out.set(this.pos.x + lx * c + lz * s, 0.03, this.pos.z - lx * s + lz * c)
  }

  get velocity(): { x: number; z: number } {
    const v = this.body.linvel()
    return { x: v.x, z: v.z }
  }
}

export function quatYaw(yaw: number): { x: number; y: number; z: number; w: number } {
  return { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }
}

export function yawOf(q: { x: number; y: number; z: number; w: number }): number {
  return 2 * Math.atan2(q.y, q.w)
}
