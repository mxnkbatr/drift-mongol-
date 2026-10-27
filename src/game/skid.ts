import * as THREE from 'three'

const MAX_QUADS = 5000

/**
 * Persistent tyre marks: one ring buffer of quads (single draw call). Each wheel strip keeps its
 * last edge pair so consecutive quads join without gaps; old marks are recycled first.
 */
export class SkidMarks {
  readonly mesh: THREE.Mesh
  private readonly pos: Float32Array
  private readonly col: Float32Array
  private next = 0
  private readonly last: Array<{ l: THREE.Vector3; r: THREE.Vector3; p: THREE.Vector3 } | null> = [null, null, null, null]
  constructor(private readonly width = 0.3) {
    const g = new THREE.BufferGeometry()
    this.pos = new Float32Array(MAX_QUADS * 4 * 3)
    this.col = new Float32Array(MAX_QUADS * 4 * 4)
    const idx = new Uint32Array(MAX_QUADS * 6)
    for (let q = 0; q < MAX_QUADS; q += 1) idx.set([q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 2, q * 4 + 1, q * 4 + 3], q * 6)
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage))
    g.setIndex(new THREE.BufferAttribute(idx, 1))
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
  }

  /** Extend wheel `i`'s mark to `p`, or lift it when `strength` is 0. */
  mark(i: number, p: THREE.Vector3, strength: number, tint = 0.02): void {
    if (strength <= 0) {
      this.last[i] = null
      return
    }
    const prev = this.last[i]
    if (!prev) {
      this.last[i] = { l: p.clone(), r: p.clone(), p: p.clone() }
      return
    }
    const dx = p.x - prev.p.x
    const dz = p.z - prev.p.z
    const d = Math.hypot(dx, dz)
    if (d < 0.35) return
    if (d > 6) {
      this.last[i] = null
      return
    }
    const nx = (-dz / d) * this.width
    const nz = (dx / d) * this.width
    const l = new THREE.Vector3(p.x + nx, 0.025, p.z + nz)
    const r = new THREE.Vector3(p.x - nx, 0.025, p.z - nz)
    if (prev.l.equals(prev.p)) {
      prev.l.set(prev.p.x + nx, 0.025, prev.p.z + nz)
      prev.r.set(prev.p.x - nx, 0.025, prev.p.z - nz)
    }
    const q = this.next
    this.next = (this.next + 1) % MAX_QUADS
    const a = Math.min(0.85, strength)
    const verts = [prev.l, prev.r, l, r]
    for (let k = 0; k < 4; k += 1) {
      this.pos.set([verts[k].x, verts[k].y, verts[k].z], (q * 4 + k) * 3)
      this.col.set([tint, tint, tint + 0.01, a], (q * 4 + k) * 4)
    }
    const g = this.mesh.geometry
    ;(g.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(g.attributes.color as THREE.BufferAttribute).needsUpdate = true
    this.last[i] = { l, r, p: p.clone() }
  }

  lift(): void {
    this.last.fill(null)
  }

  clear(): void {
    this.pos.fill(0)
    this.col.fill(0)
    this.next = 0
    this.lift()
    const g = this.mesh.geometry
    ;(g.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(g.attributes.color as THREE.BufferAttribute).needsUpdate = true
  }
}

const MAX_SMOKE = 900

/** Soft billboard smoke on one Points draw call with per-particle size and alpha. */
export class Smoke {
  readonly points: THREE.Points
  private readonly pos: Float32Array
  private readonly size: Float32Array
  private readonly alpha: Float32Array
  private readonly vel: Float32Array
  private readonly life: Float32Array
  private readonly max: Float32Array
  private next = 0
  private readonly uniforms: { uColor: { value: THREE.Color }; uScale: { value: number } }
  constructor() {
    const g = new THREE.BufferGeometry()
    this.pos = new Float32Array(MAX_SMOKE * 3)
    this.size = new Float32Array(MAX_SMOKE)
    this.alpha = new Float32Array(MAX_SMOKE)
    this.vel = new Float32Array(MAX_SMOKE * 3)
    this.life = new Float32Array(MAX_SMOKE)
    this.max = new Float32Array(MAX_SMOKE).fill(1)
    this.life.fill(1e9)
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage))
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage))
    this.uniforms = { uColor: { value: new THREE.Color('#d9d4e8') }, uScale: { value: 400 } }
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float aSize; attribute float aAlpha; varying float vAlpha; uniform float uScale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = min(aSize * uScale / max(0.5, -mv.z), uScale * 0.35);
          vAlpha = aAlpha;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d) * 2.0;
          if (r > 1.0) discard;
          float a = (1.0 - r * r) * vAlpha;
          gl_FragColor = vec4(uColor, a);
        }`,
    })
    this.points = new THREE.Points(g, mat)
    this.points.frustumCulled = false
    this.points.renderOrder = 2
  }

  setColor(color: THREE.ColorRepresentation): void {
    this.uniforms.uColor.value.set(color)
  }

  setViewport(heightPx: number, fovDeg: number): void {
    this.uniforms.uScale.value = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360))
  }

  emit(at: THREE.Vector3, carVel: { x: number; z: number }, strength: number): void {
    const i = this.next
    this.next = (this.next + 1) % MAX_SMOKE
    this.pos.set([at.x + (Math.random() - 0.5) * 0.4, 0.25, at.z + (Math.random() - 0.5) * 0.4], i * 3)
    this.vel.set([carVel.x * 0.18 + (Math.random() - 0.5) * 2.2, 0.8 + Math.random() * 1.4, carVel.z * 0.18 + (Math.random() - 0.5) * 2.2], i * 3)
    this.life[i] = 0
    this.max[i] = 1.1 + Math.random() * 1.2 + strength * 0.8
    this.size[i] = 0.6
    this.alpha[i] = 0
  }

  update(dt: number): void {
    for (let i = 0; i < MAX_SMOKE; i += 1) {
      const life = (this.life[i] += dt)
      const k = life / this.max[i]
      if (k >= 1) {
        this.alpha[i] = 0
        continue
      }
      const damp = Math.exp(-1.6 * dt)
      this.vel[i * 3] *= damp
      this.vel[i * 3 + 2] *= damp
      this.pos[i * 3] += this.vel[i * 3] * dt
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt
      this.size[i] = 0.7 + k * 3.8
      this.alpha[i] = Math.min(1, k * 6) * (1 - k) * (1 - k) * 0.42
    }
    const g = this.points.geometry
    ;(g.attributes.position as THREE.BufferAttribute).needsUpdate = true
    ;(g.attributes.aSize as THREE.BufferAttribute).needsUpdate = true
    ;(g.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true
  }

  clear(): void {
    this.life.fill(1e9)
    this.alpha.fill(0)
  }
}
