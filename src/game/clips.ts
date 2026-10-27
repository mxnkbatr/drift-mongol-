import * as THREE from 'three'
import { CONFIG, type Heat } from './config'
import type { ClipSpot } from './daily'
import { WALL } from './world'
import type { TrackSample } from './track'

type Zone = { spot: ClipSpot; ring: THREE.Mesh; disc: THREE.Mesh; pylon: THREE.Group; used: boolean; inside: boolean; flash: number }

/**
 * Clip zones: glowing rings near the barrier at the day's chosen corners. Drifting through one
 * adds a bonus and a multiplier step; the zone re-arms once the car has left it.
 */
export class ClipZones {
  readonly group = new THREE.Group()
  private zones: Zone[] = []
  private readonly ringMat = new THREE.MeshBasicMaterial({ color: '#39e6ff', transparent: true, opacity: 0.9, toneMapped: false, depthWrite: false, side: THREE.DoubleSide })
  private readonly usedMat = new THREE.MeshBasicMaterial({ color: '#ffd35c', transparent: true, opacity: 0.95, toneMapped: false, depthWrite: false, side: THREE.DoubleSide })
  private readonly discMat = new THREE.MeshBasicMaterial({ color: '#39e6ff', transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })
  private readonly bandMat = new THREE.MeshBasicMaterial({ color: '#39e6ff', toneMapped: false })
  private radius: number = CONFIG.clip.radius
  private time = 0

  constructor(spots: ClipSpot[], track: TrackSample[]) {
    const pole = new THREE.MeshStandardMaterial({ color: '#1b1838', roughness: 0.5, flatShading: true })
    for (const spot of spots) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.86, 1, 40).rotateX(-Math.PI / 2), this.ringMat)
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2), this.discMat)
      ring.position.set(spot.x, 0.06, spot.z)
      disc.position.set(spot.x, 0.05, spot.z)
      const p = track[spot.index]
      const pylon = new THREE.Group()
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.36, 3.6, 6), pole)
      post.position.y = 1.8
      pylon.add(post)
      for (let b = 0; b < 3; b += 1) {
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.28, 6), this.bandMat)
        band.position.y = 1.2 + b * 0.9
        pylon.add(band)
      }
      const off = WALL + 0.4
      pylon.position.set(p.x + p.nx * off * spot.side, 1.1, p.z + p.nz * off * spot.side)
      this.group.add(ring, disc, pylon)
      this.zones.push({ spot, ring, disc, pylon, used: false, inside: false, flash: 0 })
    }
    this.setHeat(0)
  }

  setHeat(heat: Heat): void {
    this.radius = CONFIG.clip.radius * CONFIG.clip.shrink[heat]
  }

  reset(): void {
    for (const z of this.zones) {
      z.used = false
      z.inside = false
      z.flash = 0
    }
    this.setHeat(0)
  }

  /** Returns whether the car is inside any zone and whether a clip was just scored. */
  test(x: number, z: number, drifting: boolean): { inside: boolean; entered: ClipSpot | null } {
    let inside = false
    let entered: ClipSpot | null = null
    for (const zone of this.zones) {
      const d = Math.hypot(zone.spot.x - x, zone.spot.z - z)
      zone.inside = d < this.radius
      if (zone.inside) inside = true
      if (zone.inside && drifting && !zone.used) {
        zone.used = true
        zone.flash = 1
        entered = zone.spot
      }
      if (d > this.radius * 2.6) zone.used = false
    }
    return { inside, entered }
  }

  animate(dt: number): void {
    this.time += dt
    for (const z of this.zones) {
      z.flash = Math.max(0, z.flash - dt * 1.6)
      const pulse = 1 + Math.sin(this.time * 4) * 0.03 + z.flash * 0.35
      const s = this.radius * pulse
      z.ring.scale.set(s, 1, s)
      z.disc.scale.set(s, 1, s)
      z.ring.material = z.used ? this.usedMat : this.ringMat
      ;(z.disc.material as THREE.MeshBasicMaterial).opacity = z.inside ? 0.3 : 0.12
    }
  }
}

/**
 * Chase camera: trails the velocity direction during a slide so the car shows its angle, shifts
 * sideways toward the outside of the drift, widens FOV with speed and adds crash shake.
 */
export class ChaseCamera {
  readonly camera = new THREE.PerspectiveCamera(CONFIG.camera.fov, 1, 0.1, 2500)
  private heading = 0
  private offset = 0
  private shake = 0
  private readonly focus = new THREE.Vector3()
  private readonly pos = new THREE.Vector3()
  private fov: number = CONFIG.camera.fov

  addShake(amount: number): void {
    this.shake = Math.min(1.2, this.shake + amount)
  }

  reset(target: THREE.Vector3, yaw: number): void {
    this.heading = yaw
    this.offset = 0
    this.focus.copy(target)
    this.place(target, yaw, 0, 0, 1, true, false)
  }

  update(target: THREE.Vector3, yaw: number, velocity: { x: number; z: number }, slip: number, speed: number, dt: number, reducedMotion: boolean): void {
    const C = CONFIG.camera
    const moving = speed > 3
    const velYaw = moving ? Math.atan2(velocity.x, velocity.z) : yaw
    // Blend toward the travel direction when sliding so the drift angle is visible on screen.
    const slide = Math.min(1, Math.abs(slip) / 50)
    let want = yaw + angleDiff(yaw, velYaw) * (0.35 + slide * 0.35)
    if (!moving) want = yaw
    this.heading += angleDiff(this.heading, want) * (1 - Math.exp(-4.2 * dt))
    const wantOffset = THREE.MathUtils.clamp(slip / 40, -1, 1) * C.driftOffset
    this.offset += (wantOffset - this.offset) * (1 - Math.exp(-3 * dt))
    const wantFov = C.fov + C.fovBoost * Math.min(1, speed / 40)
    this.fov += (wantFov - this.fov) * (1 - Math.exp(-3 * dt))
    this.place(target, this.heading, this.offset, slip, dt, false, reducedMotion)
  }

  private place(target: THREE.Vector3, heading: number, offset: number, slip: number, dt: number, snap: boolean, reducedMotion: boolean): void {
    const C = CONFIG.camera
    const fx = Math.sin(heading)
    const fz = Math.cos(heading)
    // Right vector of the heading; positive slip (sliding right) swings the camera to the left side.
    const rx = -fz
    const rz = fx
    const k = snap ? 1 : 1 - Math.exp(-C.follow * dt)
    this.focus.lerp(target, snap ? 1 : 1 - Math.exp(-14 * dt))
    const want = new THREE.Vector3(this.focus.x - fx * C.distance - rx * offset, C.height, this.focus.z - fz * C.distance - rz * offset)
    if (snap) this.pos.copy(want)
    else this.pos.lerp(want, k)
    this.camera.position.copy(this.pos)
    this.camera.lookAt(this.focus.x + fx * 4 + rx * offset * 0.3, 0.9, this.focus.z + fz * 4 + rz * offset * 0.3)
    this.camera.rotateZ(THREE.MathUtils.clamp(-slip / 900, -0.05, 0.05))
    if (this.shake > 0 && !reducedMotion) {
      const s = this.shake * this.shake * 0.45
      this.camera.position.add(new THREE.Vector3((Math.random() - 0.5) * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * s))
    }
    this.shake = Math.max(0, this.shake - dt * 2.2)
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov
      this.camera.updateProjectionMatrix()
    }
  }

  /** Orbiting establishing shot for the title screen. */
  orbit(target: THREE.Vector3, time: number): void {
    const a = time * 0.16
    // Low, slightly upward shot: the car against the skyline and the day's sky.
    this.camera.position.set(target.x + Math.sin(a) * 9.5, 1.9 + Math.sin(time * 0.3) * 0.4, target.z + Math.cos(a) * 9.5)
    this.camera.lookAt(target.x, 2.6, target.z)
    this.focus.copy(target)
    this.pos.copy(this.camera.position)
    this.heading = a + Math.PI
  }
}

export function angleDiff(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from))
}
