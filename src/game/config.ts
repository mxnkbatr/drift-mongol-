/**
 * All gameplay tuning in one place. Tests and the server anti-cheat limits read the same numbers
 * (server/drift-rules.mjs mirrors SCORE limits), so keep them in sync when tuning.
 */
export const CONFIG = {
  run: {
    seconds: 60,
    /** The clock waits for the first throttle/steer input, but never longer than this. */
    autoStart: 3,
  },
  car: {
    halfWidth: 0.95,
    halfLength: 2.05,
    maxSpeed: 42,
    engineForce: 17,
    /** Extra acceleration at low speed so launches feel punchy. */
    launchBoost: 12,
    brakeForce: 30,
    reverseSpeed: 9,
    drag: 0.0062,
    rolling: 0.9,
    /** Lateral velocity decay rates (1/s): planted, sliding with throttle, handbrake. */
    grip: 7.5,
    driftGrip: 1.45,
    handbrakeGrip: 0.55,
    /** Yaw response (rad/s at full lock). */
    steerRate: 2.3,
    driftSteerRate: 3.2,
    yawResponse: 9,
    /** Handbrake kick that swings the tail when entering a drift. */
    handbrakeKick: 1.4,
    /** Sliding scrubs speed proportional to lateral velocity. */
    slideScrub: 0.1,
    /** Throttle during a slide keeps some momentum along the heading. */
    driftPush: 0.6,
    /** Straightening assist when no steering is applied in a slide (prevents easy spins). */
    assist: 1.3,
  },
  drift: {
    /** Slip angle (degrees) and speed (m/s) above which a slide counts as a drift. */
    minAngle: 13,
    minSpeed: 7,
    /** Angles past this spin the car out and lose the segment. */
    spinAngle: 118,
    /** How long the chain survives after a drift ends before the segment banks (per heat). */
    chainGrace: [1.35, 1.15, 0.95, 0.8],
    /** Seconds of drifting per multiplier step, and the multiplier cap. */
    multStep: 1.4,
    multMax: 10,
    /** Wall contacts with a speed change above this (m/s) crash the segment. */
    crashDv: 2.2,
    /** Continuous barrier contact longer than this (s) also counts as a crash. */
    scrapeTime: 0.3,
    /** Metres from the wall that count as a near miss while drifting fast. */
    nearMiss: 1.15,
    nearMissSpeed: 14,
    nearMissCooldown: 1.6,
  },
  score: {
    /** Base drift points per second before angle/speed/heat/clip factors. */
    rate: 60,
    angleMax: 3,
    speedMax: 1.6,
    clipFactor: 2,
    clipBonus: 250,
    nearMissBonus: 150,
    /** Heat levels start at these elapsed run seconds; each multiplies drift points. */
    heatAt: [0, 20, 40, 50],
    heatMult: [1, 1.5, 2, 3],
    /** Segment ratings by banked points (ascending thresholds for rating 1..6). */
    ratings: [300, 1500, 4000, 9000, 18000, 32000],
  },
  clip: {
    radius: 6.5,
    /** Clip zones shrink with heat. */
    shrink: [1, 0.9, 0.8, 0.72],
    perDay: 7,
  },
  camera: {
    distance: 7.6,
    height: 3.2,
    fov: 62,
    fovBoost: 14,
    /** Lateral shift (m) toward the outside of a drift. */
    driftOffset: 2.8,
    follow: 6.5,
  },
} as const

export type Heat = 0 | 1 | 2 | 3
