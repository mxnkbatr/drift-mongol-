import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Physics } from '../engine/physics'
import { RAPIER } from '../engine/physics'
import { radialTexture } from './car'
import { type Condition, rng } from './daily'
import { buildTrack, findCorners, HALF_WIDTH, type Corner, type TrackSample } from './track'
import type { MapId } from '../engine/save'

/** Barrier face distance from the centreline: road half width plus a curb/runoff strip. */
export const WALL = HALF_WIDTH + 1.4

function canvas(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d')!)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.anisotropy = 8
  return t
}

function roadTexture(): THREE.CanvasTexture {
  return canvas(256, 512, ctx => {
    ctx.fillStyle = '#bfbfc6'
    ctx.fillRect(0, 0, 256, 512)
    const r = rng(11)
    for (let i = 0; i < 2600; i += 1) {
      const v = 150 + Math.floor(r() * 90)
      ctx.fillStyle = `rgb(${v},${v},${v + 6})`
      ctx.fillRect(r() * 256, r() * 512, 2, 2)
    }
    // Lane edges and a dashed centre line (dash 3 m of every 10 m).
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(7, 0, 5, 512)
    ctx.fillRect(244, 0, 5, 512)
    ctx.fillStyle = '#ffd35c'
    ctx.fillRect(125, 0, 6, 150)
    ctx.fillStyle = 'rgba(255,255,255,0.5)'
    ctx.fillRect(66, 300, 3, 70)
    ctx.fillRect(189, 300, 3, 70)
  })
}

/** Retro-reflective paint: lane markings only, used as the road's emissive map. */
function lineTexture(): THREE.CanvasTexture {
  return canvas(256, 512, ctx => {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, 256, 512)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(7, 0, 5, 512)
    ctx.fillRect(244, 0, 5, 512)
    ctx.fillStyle = '#ffd35c'
    ctx.fillRect(125, 0, 6, 150)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    ctx.fillRect(66, 300, 3, 70)
    ctx.fillRect(189, 300, 3, 70)
  })
}

function windowTexture(): THREE.CanvasTexture {
  return canvas(512, 512, ctx => {
    ctx.fillStyle = '#0c0b16'
    ctx.fillRect(0, 0, 512, 512)
    const r = rng(5)
    const warm = ['#ffcf7a', '#ffe2a8', '#ffb35c']
    const cool = ['#8fd8ff', '#b7c6ff', '#d7a8ff']
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const lit = r()
        ctx.fillStyle = lit < 0.42 ? '#161527' : lit < 0.8 ? warm[Math.floor(r() * 3)] : cool[Math.floor(r() * 3)]
        ctx.fillRect(x * 64 + 12, y * 64 + 14, 40, 34)
      }
    }
  })
}

function bannerTexture(): THREE.CanvasTexture {
  return canvas(1024, 128, ctx => {
    for (let x = 0; x < 64; x += 1) {
      for (let y = 0; y < 2; y += 1) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'
        ctx.fillRect(x * 16, y * 16, 16, 16)
        ctx.fillRect(x * 16, 96 + y * 16, 16, 16)
      }
    }
    ctx.fillStyle = '#1b1838'
    ctx.fillRect(0, 32, 1024, 64)
    ctx.font = '900 italic 50px Sora, "Noto Sans SC", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = '#ffd35c'
    ctx.fillText('ДРИФТИЙН ХААН  ·  ТАЛЫН НЕОН  ·  DRIFT KING', 512, 66)
  })
}

type Sky = { mesh: THREE.Mesh; top: THREE.Color; horizon: THREE.Color }

/**
 * The procedural night-city circuit: road ribbon, curbs, neon barriers (with Rapier colliders),
 * city blocks, street lamps, sky, stars and rain. Everything is generated from primitives and a
 * fixed seed, so the layout is identical for everyone.
 */
export class World {
  readonly scene = new THREE.Scene()
  readonly track: TrackSample[]
  readonly corners: Corner[]
  readonly sun: THREE.DirectionalLight
  readonly hemi: THREE.HemisphereLight
  readonly spawn: { x: number; z: number; yaw: number }
  private readonly sky: Sky
  private readonly stars: THREE.Points
  private readonly rain: THREE.LineSegments
  private readonly rainPos: Float32Array
  private readonly roadMat: THREE.MeshStandardMaterial
  private readonly buildingMat: THREE.MeshStandardMaterial
  private readonly poolMat: THREE.MeshBasicMaterial
  private readonly bulbMat: THREE.MeshBasicMaterial
  private readonly moon: THREE.Sprite
  private condition?: Condition
  private time = 0

  constructor(private readonly physics: Physics, shadowMapSize: number, mapId: MapId = 'ub') {
    this.track = buildTrack()
    this.corners = findCorners(this.track)
    const t0 = this.track[4]
    this.spawn = { x: t0.x, z: t0.z, yaw: Math.atan2(t0.tx, t0.tz) }
    const scene = this.scene
    scene.fog = new THREE.FogExp2('#171133', 0.006)

    this.hemi = new THREE.HemisphereLight('#6c78d8', '#1a1030', 0.6)
    scene.add(this.hemi)
    this.sun = new THREE.DirectionalLight('#9fb4ff', 0.6)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize)
    const sc = this.sun.shadow.camera
    sc.left = sc.bottom = -34
    sc.right = sc.top = 34
    sc.near = 1
    sc.far = 160
    this.sun.shadow.bias = -0.0008
    scene.add(this.sun, this.sun.target)

    this.sky = this.buildSky()
    this.stars = this.buildStars()
    this.moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture('rgba(255,250,235,1)', 'rgba(255,240,210,0)'), fog: false, depthWrite: false, toneMapped: false }))
    this.moon.scale.setScalar(110)
    this.moon.position.set(-420, 330, -520)
    scene.add(this.moon)

    this.roadMat = new THREE.MeshStandardMaterial({ map: roadTexture(), color: '#6b6e8c', roughness: 0.8, metalness: 0.1, emissiveMap: lineTexture(), emissive: '#ffffff', emissiveIntensity: 0.5 })
    this.buildRoad()
    this.buildShoulders()
    this.buildBarriers()
    const windows = windowTexture()
    this.buildingMat = new THREE.MeshStandardMaterial({ map: windows, emissiveMap: windows, emissive: '#ffffff', emissiveIntensity: 1.2, vertexColors: true, roughness: 0.85, flatShading: true })
    if (mapId === 'ub') this.buildCity()
    else this.buildSteppe(mapId)
    this.bulbMat = new THREE.MeshBasicMaterial({ color: '#ffe3a3', toneMapped: false })
    this.poolMat = new THREE.MeshBasicMaterial({ map: radialTexture('rgba(255,214,160,0.6)', 'rgba(255,200,130,0)'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    this.buildLamps()
    this.buildGantry()

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#262334', roughness: 1 }))
    ground.position.set(25, -0.05, 130)
    ground.receiveShadow = true
    scene.add(ground)

    this.rainPos = new Float32Array(1800 * 6)
    const rg = new THREE.BufferGeometry()
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3).setUsage(THREE.DynamicDrawUsage))
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: '#a8c8ff', transparent: true, opacity: 0.4, depthWrite: false }))
    this.rain.frustumCulled = false
    this.rain.visible = false
    const r = rng(3)
    for (let i = 0; i < 1800; i += 1) {
      const x = (r() - 0.5) * 60
      const y = r() * 30
      const z = (r() - 0.5) * 60
      this.rainPos.set([x, y, z, x + 0.08, y + 0.9, z + 0.05], i * 6)
    }
    scene.add(this.rain)
  }

  private buildSky(): Sky {
    const top = new THREE.Color()
    const horizon = new THREE.Color()
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1100, 24, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { uTop: { value: top }, uHorizon: { value: horizon } },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 uTop; uniform vec3 uHorizon; varying vec3 vDir; void main(){ float h = clamp(vDir.y * 1.6 + 0.08, 0.0, 1.0); vec3 c = mix(uHorizon, uTop, pow(h, 0.7)); gl_FragColor = vec4(c, 1.0);\n#include <colorspace_fragment>\n}',
      }),
    )
    mesh.renderOrder = -10
    this.scene.add(mesh)
    return { mesh, top, horizon }
  }

  private buildStars(): THREE.Points {
    const r = rng(9)
    const n = 700
    const p = new Float32Array(n * 3)
    for (let i = 0; i < n; i += 1) {
      const a = r() * Math.PI * 2
      const e = 0.12 + r() * 1.3
      p.set([Math.cos(a) * Math.cos(e) * 1000, Math.sin(e) * 1000, Math.sin(a) * Math.cos(e) * 1000], i * 3)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(p, 3))
    const stars = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }))
    this.scene.add(stars)
    return stars
  }

  private buildRoad(): void {
    const n = this.track.length
    const pos: number[] = []
    const uv: number[] = []
    const idx: number[] = []
    const total = this.track[n - 1].s + Math.hypot(this.track[0].x - this.track[n - 1].x, this.track[0].z - this.track[n - 1].z)
    // Round the texture length so the loop closes without a visible seam.
    const reps = Math.round(total / 10)
    for (let i = 0; i <= n; i += 1) {
      const p = this.track[i % n]
      const s = i === n ? total : p.s
      pos.push(p.x + p.nx * HALF_WIDTH, 0, p.z + p.nz * HALF_WIDTH, p.x - p.nx * HALF_WIDTH, 0, p.z - p.nz * HALF_WIDTH)
      const v = (s / total) * reps
      uv.push(0, v, 1, v)
      if (i < n) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2)
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    g.setIndex(idx)
    g.computeVertexNormals()
    const road = new THREE.Mesh(g, this.roadMat)
    road.receiveShadow = true
    this.scene.add(road)
    // Chequered start/finish line.
    const t = this.track[0]
    const checker = canvas(256, 32, ctx => {
      for (let x = 0; x < 16; x += 1) for (let y = 0; y < 2; y += 1) {
        ctx.fillStyle = (x + y) % 2 ? '#15131f' : '#f1f1f1'
        ctx.fillRect(x * 16, y * 16, 16, 16)
      }
    })
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HALF_WIDTH * 2, 2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: checker, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -1 }))
    line.position.set(t.x, 0.012, t.z)
    line.rotation.y = Math.atan2(t.tx, t.tz)
    line.receiveShadow = true
    this.scene.add(line)
  }

  /** Curb / gutter strip between the road edge and the barrier; red-white curbs mark corners. */
  private buildShoulders(): void {
    const n = this.track.length
    const pos: number[] = []
    const col: number[] = []
    const red = new THREE.Color('#e8344e')
    const white = new THREE.Color('#f2eee6')
    const grey = new THREE.Color('#5c5a72')
    for (let i = 0; i < n; i += 1) {
      const a = this.track[i]
      const b = this.track[(i + 1) % n]
      const corner = Math.abs(a.curv) > 1 / 70
      for (const side of [1, -1]) {
        const c = corner ? (Math.floor(a.s / 2) % 2 ? red : white) : grey
        const y = corner ? 0.035 : 0.01
        const p = (q: TrackSample, off: number) => [q.x + q.nx * off * side, y, q.z + q.nz * off * side]
        const quad = [p(a, HALF_WIDTH), p(a, WALL), p(b, HALF_WIDTH), p(b, WALL)]
        const order = side === 1 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 1, 3, 2]
        for (const k of order) {
          pos.push(...quad[k])
          col.push(c.r, c.g, c.b)
        }
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    g.computeVertexNormals()
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide }))
    m.receiveShadow = true
    this.scene.add(m)
  }

  /** Concrete barriers with a neon top strip; each short section gets a matching Rapier box. */
  private buildBarriers(): void {
    const n = this.track.length
    const H = 1.1
    const T = 0.7
    for (const side of [1, -1]) {
      const pos: number[] = []
      const col: number[] = []
      const neon: number[] = []
      const a = new THREE.Color('#4a4766')
      const b = new THREE.Color('#5d5a80')
      for (let i = 0; i < n; i += 1) {
        const p = this.track[i]
        const q = this.track[(i + 1) % n]
        const at = (s: TrackSample, off: number, y: number) => [s.x + s.nx * off * side, y, s.z + s.nz * off * side]
        const c = Math.floor(p.s / 4) % 2 ? a : b
        const faces = [
          [at(p, WALL, 0), at(q, WALL, 0), at(p, WALL, H), at(q, WALL, H)],
          [at(p, WALL, H), at(q, WALL, H), at(p, WALL + T, H), at(q, WALL + T, H)],
          [at(p, WALL + T, H), at(q, WALL + T, H), at(p, WALL + T, 0), at(q, WALL + T, 0)],
        ]
        for (const f of faces) {
          const order = side === 1 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 1, 3, 2]
          for (const k of order) {
            pos.push(...f[k])
            col.push(c.r, c.g, c.b)
          }
        }
        const s0 = [at(p, WALL - 0.02, H - 0.2), at(q, WALL - 0.02, H - 0.2), at(p, WALL - 0.02, H - 0.05), at(q, WALL - 0.02, H - 0.05)]
        for (const k of side === 1 ? [0, 2, 1, 1, 2, 3] : [0, 1, 2, 1, 3, 2]) neon.push(...s0[k])
        if (i % 2 === 0) {
          const e = this.track[(i + 2) % n]
          const ax = p.x + p.nx * (WALL + 0.45) * side
          const az = p.z + p.nz * (WALL + 0.45) * side
          const bx = e.x + e.nx * (WALL + 0.45) * side
          const bz = e.z + e.nz * (WALL + 0.45) * side
          const len = Math.hypot(bx - ax, bz - az) + 0.7
          const yaw = Math.atan2(bx - ax, bz - az)
          this.physics.world.createCollider(
            RAPIER.ColliderDesc.cuboid(0.45, 1, len / 2)
              .setTranslation((ax + bx) / 2, 0.6, (az + bz) / 2)
              .setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) })
              .setFriction(0.05)
              .setRestitution(0.2),
          )
        }
      }
      const g = new THREE.BufferGeometry()
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
      g.computeVertexNormals()
      const wall = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, flatShading: true, side: THREE.DoubleSide }))
      wall.castShadow = wall.receiveShadow = true
      this.scene.add(wall)
      const ng = new THREE.BufferGeometry()
      ng.setAttribute('position', new THREE.Float32BufferAttribute(neon, 3))
      this.scene.add(new THREE.Mesh(ng, new THREE.MeshBasicMaterial({ color: side === 1 ? '#39e6ff' : '#ff4fd8', toneMapped: false, side: THREE.DoubleSide })))
    }
  }

  private distanceToTrack(x: number, z: number): number {
    let best = Infinity
    for (let i = 0; i < this.track.length; i += 2) {
      const p = this.track[i]
      const d = (p.x - x) ** 2 + (p.z - z) ** 2
      if (d < best) best = d
    }
    return Math.sqrt(best)
  }

  /** Steppe Neon backdrop: rounded hills, gers, dust markers, and optional Kharkhorin stones. */
  private buildSteppe(mapId: MapId): void {
    const r = rng(mapId === 'steppe' ? 720 : 721)
    const hillMat = new THREE.MeshStandardMaterial({ color: mapId === 'steppe' ? '#274866' : '#3b365b', roughness: 1, flatShading: true })
    const grassMat = new THREE.MeshStandardMaterial({ color: mapId === 'steppe' ? '#526b50' : '#4d5365', roughness: 1, flatShading: true })
    const gerMat = new THREE.MeshStandardMaterial({ color: '#e4c892', roughness: 0.95, flatShading: true })
    const roofMat = new THREE.MeshStandardMaterial({ color: '#b74445', roughness: 0.85, flatShading: true })
    for (let i = 0; i < 34; i += 1) {
      const a = (i / 34) * Math.PI * 2 + r() * 0.25
      const radius = 190 + r() * 180
      const hill = new THREE.Mesh(new THREE.ConeGeometry(24 + r() * 36, 18 + r() * 40, 7), hillMat)
      hill.position.set(25 + Math.cos(a) * radius, 8 + r() * 12, 130 + Math.sin(a) * radius)
      hill.rotation.y = r() * Math.PI
      this.scene.add(hill)
    }
    for (let i = 0; i < 10; i += 1) {
      const a = r() * Math.PI * 2
      const radius = 65 + r() * 150
      const x = 25 + Math.cos(a) * radius
      const z = 130 + Math.sin(a) * radius
      if (this.distanceToTrack(x, z) < 26) continue
      const ger = new THREE.Group()
      ger.add(new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 2.3, 12), gerMat))
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4.4, 2.2, 12), roofMat)
      roof.position.y = 2.25
      ger.add(roof)
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.35, 0.08), new THREE.MeshBasicMaterial({ color: '#251b2d' }))
      door.position.set(0, 0.7, 3.58)
      ger.add(door)
      ger.position.set(x, 0, z)
      ger.rotation.y = r() * Math.PI * 2
      this.scene.add(ger)
    }
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(1900, 1900).rotateX(-Math.PI / 2), grassMat)
    grass.position.set(25, -0.03, 130)
    grass.receiveShadow = true
    this.scene.add(grass)
    if (mapId === 'kharkhorin') {
      const stoneMat = new THREE.MeshStandardMaterial({ color: '#8d857b', roughness: 1, flatShading: true })
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2
        const stone = new THREE.Mesh(new THREE.BoxGeometry(2.6 + r() * 2, 9 + r() * 9, 1.5 + r()), stoneMat)
        stone.position.set(25 + Math.cos(a) * 82, stone.geometry.parameters.height / 2, 130 + Math.sin(a) * 82)
        stone.rotation.y = a + r() * 0.4
        this.scene.add(stone)
      }
    }
  }

  private buildCity(): void {
    const r = rng(2026)
    const parts: THREE.BufferGeometry[] = []
    const signs: THREE.BufferGeometry[] = []
    const facade = ['#102f52', '#173c5a', '#24465a', '#3e314d', '#46374f', '#25465b'].map(c => new THREE.Color(c))
    const neon = ['#d63e4d', '#44d8e8', '#ffd166', '#e6b84d', '#8bd17c'].map(c => new THREE.Color(c))
    const addBox = (x: number, z: number, w: number, h: number, d: number, yaw: number, tint: THREE.Color) => {
      const g = new THREE.BoxGeometry(w, h, d).toNonIndexed()
      const uv = g.attributes.uv as THREE.BufferAttribute
      const nrm = g.attributes.normal as THREE.BufferAttribute
      for (let i = 0; i < uv.count; i += 1) {
        const ny = nrm.getY(i)
        if (Math.abs(ny) > 0.5) uv.setXY(i, 0.01, 0.01)
        else {
          const faceW = Math.abs(nrm.getX(i)) > 0.5 ? d : w
          uv.setXY(i, uv.getX(i) * (faceW / 32), uv.getY(i) * (h / 28))
        }
      }
      const colors = new Float32Array(uv.count * 3)
      for (let i = 0; i < uv.count; i += 1) colors.set([tint.r, tint.g, tint.b], i * 3)
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
      g.rotateY(yaw)
      g.translate(x, h / 2, z)
      parts.push(g)
    }
    const minX = -170
    const maxX = 230
    const minZ = -90
    const maxZ = 350
    for (let x = minX; x < maxX; x += 21) {
      for (let z = minZ; z < maxZ; z += 21) {
        const cx = x + (r() - 0.5) * 6
        const cz = z + (r() - 0.5) * 6
        const w = 9 + r() * 9
        const d = 9 + r() * 9
        const dist = this.distanceToTrack(cx, cz)
        if (dist < WALL + 6 + Math.max(w, d) * 0.72) continue
        if (r() < 0.12) continue
        const near = dist < 45
        const h = near ? 8 + r() * 26 : 14 + r() * 50
        const tint = facade[Math.floor(r() * facade.length)]
        addBox(cx, cz, w, h, d, 0, tint)
        if (r() < 0.35) addBox(cx + (r() - 0.5) * w * 0.3, cz + (r() - 0.5) * d * 0.3, w * 0.55, h + 4 + r() * 10, d * 0.55, 0, tint)
        if (near && r() < 0.55) {
          const c = neon[Math.floor(r() * neon.length)]
          const sw = 0.9 + r() * 0.6
          const sh = 4 + r() * 7
          const g = new THREE.BoxGeometry(sw, sh, sw).toNonIndexed()
          const colors = new Float32Array(g.attributes.position.count * 3)
          for (let i = 0; i < colors.length / 3; i += 1) colors.set([c.r, c.g, c.b], i * 3)
          g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
          const sx = cx + (r() < 0.5 ? -1 : 1) * (w / 2 + sw / 2)
          const sz = cz + (r() - 0.5) * d * 0.6
          g.translate(sx, Math.min(h - 2, 6 + r() * 12) , sz)
          signs.push(g)
        }
      }
    }
    // Distant skyline ring, mostly silhouettes in the fog.
    for (let i = 0; i < 90; i += 1) {
      const a = (i / 90) * Math.PI * 2 + r() * 0.03
      const rad = 380 + r() * 120
      addBox(25 + Math.cos(a) * rad, 130 + Math.sin(a) * rad, 22 + r() * 20, 40 + r() * 110, 22 + r() * 20, -a, facade[Math.floor(r() * facade.length)])
    }
    const city = new THREE.Mesh(mergeGeometries(parts), this.buildingMat)
    city.receiveShadow = true
    this.scene.add(city)
    if (signs.length) this.scene.add(new THREE.Mesh(mergeGeometries(signs), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false })))
  }

  private buildLamps(): void {
    const n = this.track.length
    const poles: THREE.BufferGeometry[] = []
    const bulbs: THREE.BufferGeometry[] = []
    const pools: THREE.BufferGeometry[] = []
    let side = 1
    for (let i = 3; i < n; i += 12) {
      const p = this.track[i]
      side = -side
      const base = WALL + 1.3
      const x = p.x + p.nx * base * side
      const z = p.z + p.nz * base * side
      const armX = -p.nx * side
      const armZ = -p.nz * side
      poles.push(new THREE.CylinderGeometry(0.14, 0.2, 8, 6).translate(x, 4, z))
      const arm = new THREE.BoxGeometry(0.16, 0.16, 3.2)
      arm.rotateY(Math.atan2(armX, armZ))
      arm.translate(x + armX * 1.5, 7.9, z + armZ * 1.5)
      poles.push(arm)
      bulbs.push(new THREE.BoxGeometry(0.9, 0.18, 0.5).rotateY(Math.atan2(armX, armZ)).translate(x + armX * 3, 7.75, z + armZ * 3))
      pools.push(new THREE.PlaneGeometry(21, 21).rotateX(-Math.PI / 2).translate(x + armX * 4.5, 0.04, z + armZ * 4.5))
    }
    const pole = new THREE.Mesh(mergeGeometries(poles), new THREE.MeshStandardMaterial({ color: '#3b3852', roughness: 0.6, metalness: 0.4, flatShading: true }))
    pole.castShadow = true
    this.scene.add(pole)
    this.scene.add(new THREE.Mesh(mergeGeometries(bulbs), this.bulbMat))
    const pool = new THREE.Mesh(mergeGeometries(pools), this.poolMat)
    pool.renderOrder = 1
    this.scene.add(pool)
  }

  private buildGantry(): void {
    const t = this.track[0]
    const yaw = Math.atan2(t.tx, t.tz)
    const g = new THREE.Group()
    const dark = new THREE.MeshStandardMaterial({ color: '#2a2552', roughness: 0.5, metalness: 0.5, flatShading: true })
    for (const s of [1, -1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(1.1, 9, 1.1), dark)
      pillar.position.set(-s * (WALL + 1.2), 4.5, 0)
      pillar.castShadow = true
      g.add(pillar)
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry((WALL + 1.8) * 2, 1.6, 1), dark)
    beam.position.y = 8.6
    g.add(beam)
    const tex = bannerTexture()
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    const bannerMat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })
    for (const s of [1, -1]) {
      const banner = new THREE.Mesh(new THREE.PlaneGeometry(WALL * 2 + 2, 2.2), bannerMat)
      banner.position.set(0, 8.6, s * 0.52)
      if (s < 0) banner.rotation.y = Math.PI
      g.add(banner)
    }
    g.position.set(t.x, 0, t.z)
    g.rotation.y = yaw
    this.scene.add(g)
  }

  applyCondition(c: Condition, renderer: THREE.WebGLRenderer): void {
    this.condition = c
    this.sky.top.set(c.skyTop)
    this.sky.horizon.set(c.skyHorizon)
    const fog = this.scene.fog as THREE.FogExp2
    fog.color.set(c.fog)
    fog.density = c.fogDensity
    this.hemi.color.set(c.hemiSky)
    this.hemi.groundColor.set(c.hemiGround)
    this.hemi.intensity = c.hemi
    this.sun.color.set(c.sun)
    this.sun.intensity = c.sunIntensity
    this.stars.visible = c.stars
    this.moon.visible = c.id === 'night' || c.id === 'fog'
    this.rain.visible = c.rain
    this.roadMat.color.set(c.road)
    this.roadMat.roughness = c.roadRoughness
    this.roadMat.metalness = c.rain ? 0.35 : 0.1
    this.buildingMat.emissiveIntensity = c.windows
    this.bulbMat.color.set('#ffe3a3').multiplyScalar(Math.max(0.5, c.lamps))
    this.poolMat.opacity = Math.min(1, 0.35 + c.lamps * 0.6)
    // Lane paint glows more when it is dark, less in daylight-ish conditions.
    this.roadMat.emissiveIntensity = 0.25 + Math.min(1.5, c.lamps) * 0.3
    renderer.toneMappingExposure = c.exposure
    const low = c.id === 'dusk' || c.id === 'dawn'
    this.moon.material.color.set(low ? '#ffb070' : '#fff6e0')
    if (low) this.moon.position.set(-600, 60, -300)
    else this.moon.position.set(-420, 330, -520)
  }

  /** Follow the focus point with the shadow camera and the rain volume. */
  update(dt: number, focus: THREE.Vector3, camera: THREE.Camera): void {
    this.time += dt
    const c = this.condition
    const elev = c?.sunElevation ?? 0.9
    this.sun.position.set(focus.x - 40 * Math.cos(elev), 60 * Math.sin(elev) + 10, focus.z - 30)
    this.sun.target.position.copy(focus)
    this.sky.mesh.position.copy(camera.position)
    this.stars.position.copy(camera.position)
    if (this.rain.visible) {
      const cx = camera.position.x
      const cy = camera.position.y
      const cz = camera.position.z
      for (let i = 0; i < 1800; i += 1) {
        const o = i * 6
        let y = this.rainPos[o + 1] - 32 * dt
        let x = this.rainPos[o]
        let z = this.rainPos[o + 2]
        if (y < cy - 12 || Math.abs(x - cx) > 30 || Math.abs(z - cz) > 30) {
          y = cy + 18 + Math.random() * 6
          x = cx + (Math.random() - 0.5) * 60
          z = cz + (Math.random() - 0.5) * 60
        }
        this.rainPos[o] = x
        this.rainPos[o + 1] = y
        this.rainPos[o + 2] = z
        this.rainPos[o + 3] = x + 0.08
        this.rainPos[o + 4] = y + 0.9
        this.rainPos[o + 5] = z + 0.05
      }
      ;(this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true
    }
  }
}
