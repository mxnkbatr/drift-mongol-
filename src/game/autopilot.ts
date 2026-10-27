import type { Controls } from './car'
import { angleDiff } from './clips'
import { project, sampleAt, type TrackSample } from './track'

/**
 * `drift` 0..1 = how much slip the bot aims for in corners; `lookAhead` metres; `throttle` cap;
 * `margin` metres it keeps from the walls; `pace` scales corner speed.
 */
export type BotStyle = { lookAhead: number; drift: number; throttle: number; margin: number; pace: number; digital?: boolean }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Driver used for the title-screen attract drive and automated balance tests. It steers the
 * *course* (velocity direction) toward a look-ahead point on the centreline and holds the car's
 * nose ahead of the course by a target slip angle in corners, flicking the handbrake on entry.
 */
export class Autopilot {
  private hint = -1
  private handbrakeTimer = 0
  private cooldown = 0
  constructor(private readonly track: TrackSample[], public style: BotStyle = { lookAhead: 12, drift: 0.8, throttle: 1, margin: 2.2, pace: 1 }) {}

  reset(): void {
    this.hint = -1
    this.handbrakeTimer = 0
    this.cooldown = 0
  }

  drive(x: number, z: number, yaw: number, vx: number, vz: number, dt: number): Controls {
    const s = this.style
    const pr = project(this.track, { x, z }, this.hint)
    this.hint = pr.index
    const speed = Math.hypot(vx, vz)
    const course = speed > 2 ? Math.atan2(vx, vz) : yaw
    // Signed curvature over the next ~10-40 m decides the corner and its direction.
    let curvSum = 0
    let curvMax = 0
    for (let k = 4; k < 22; k += 2) {
      const c = sampleAt(this.track, pr.index + k).curv
      curvSum += c
      curvMax = Math.max(curvMax, Math.abs(c))
    }
    const steps = Math.round((s.lookAhead + speed * 0.35) / 2)
    const target = sampleAt(this.track, pr.index + steps)
    // Aim a little toward the inside of the coming corner, and away from a wall we are close to.
    const inside = clamp(-curvSum * 60, -3, 3)
    const limit = 9.4 - s.margin
    const pull = Math.abs(pr.lateral) > limit - 2 ? -Math.sign(pr.lateral) * (Math.abs(pr.lateral) - (limit - 2)) * 2.5 : 0
    const aimLat = clamp(inside + pull - pr.lateral * 0.15, -limit, limit)
    const aimX = target.x + target.nx * aimLat
    const aimZ = target.z + target.nz * aimLat
    const want = Math.atan2(aimX - x, aimZ - z)
    const courseErr = angleDiff(course, want)
    // Corner: lead the course by up to `maxSlip`; straights: line the nose up with the course.
    const cornering = curvMax > 1 / 70
    const maxSlip = cornering ? 0.18 + s.drift * 0.62 : 0.12
    const yawTarget = course + clamp(courseErr * (cornering ? 2.2 : 1.4), -maxSlip, maxSlip)
    const yawErr = angleDiff(yaw, yawTarget)
    let steer = clamp(-yawErr * 3.2, -1, 1)
    // Keyboard-style driver: full lock or nothing.
    if (s.digital) steer = Math.abs(steer) > 0.35 ? Math.sign(steer) : 0
    // Speed: slow for tight corners (sliding cars carry less grip).
    const vCorner = (Math.sqrt(11 / Math.max(curvMax, 1 / 400)) + 5) * s.pace
    const tooFast = speed > vCorner * 1.12
    this.handbrakeTimer = Math.max(0, this.handbrakeTimer - dt)
    this.cooldown = Math.max(0, this.cooldown - dt)
    const slip = Math.abs(angleDiff(course, yaw))
    if (cornering && s.drift > 0.2 && slip < 0.25 && Math.abs(courseErr) > 0.12 && speed > 13 && this.cooldown <= 0) {
      this.handbrakeTimer = 0.12 + s.drift * 0.16
      this.cooldown = 1.1
    }
    return {
      throttle: tooFast ? 0.25 : s.throttle,
      brake: speed > vCorner * 1.3 ? 0.5 : 0,
      steer,
      handbrake: this.handbrakeTimer > 0,
    }
  }
}
