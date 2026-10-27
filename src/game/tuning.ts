import { CONFIG } from './config'

type Mode = 'LIVE' | 'NEXT_RUN'
type Binding = {
  control: { id: string; type: 'number'; category: string; label: string; description: string; unit: string; default: number; min: number; max: number; step: number; applyMode: Mode; integrity: 'COSMETIC' | 'GAMEPLAY' }
  read(): number
  write(value: number): void
}

const binding = <T extends keyof typeof CONFIG, K extends keyof (typeof CONFIG)[T]>(
  section: T,
  key: K,
  label: string,
  min: number,
  max: number,
  step: number,
  unit: string,
  category: string,
  integrity: 'COSMETIC' | 'GAMEPLAY' = 'GAMEPLAY',
  applyMode: Mode = 'LIVE',
): Binding => {
  const values = CONFIG[section] as Record<string, number>
  const id = `${String(section)}.${String(key)}`
  const defaultValue = values[String(key)]
  return {
    control: Object.freeze({ id, type: 'number', category, label, description: applyMode === 'NEXT_RUN' ? 'Applies when the next run starts.' : 'Updates this preview immediately.', unit, default: defaultValue, min, max, step, applyMode, integrity }),
    read: () => values[String(key)],
    write: value => { values[String(key)] = value },
  }
}

const bindings: Binding[] = [
  binding('car', 'maxSpeed', 'Top speed', 20, 60, 1, 'm/s', 'Car'),
  binding('car', 'grip', 'Road grip', 3, 12, 0.25, '', 'Car'),
  binding('car', 'driftGrip', 'Drift grip', 0.3, 3, 0.05, '', 'Car'),
  binding('drift', 'multMax', 'Combo cap', 4, 12, 1, 'x', 'Scoring', 'GAMEPLAY', 'NEXT_RUN'),
  binding('camera', 'fov', 'Camera FOV', 50, 80, 1, '°', 'Camera', 'COSMETIC'),
  binding('camera', 'follow', 'Camera follow', 3, 10, 0.5, '', 'Camera', 'COSMETIC'),
]

const byId = new Map(bindings.map(value => [value.control.id, value]))
let requested = Object.fromEntries(bindings.map(value => [value.control.id, value.control.default]))
let unranked = false

export const tuning = {
  get unranked(): boolean { return unranked },
  controls: Object.freeze(bindings.map(value => value.control)),
  read() {
    return { requested: { ...requested }, active: Object.fromEntries(bindings.map(value => [value.control.id, value.read()])) }
  },
  apply(patch: unknown): void {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid patch')
    const entries = Object.entries(patch)
    const next = { ...requested }
    for (const [id, value] of entries) {
      const current = byId.get(id)
      if (!current || typeof value !== 'number' || !Number.isFinite(value) || value < current.control.min || value > current.control.max) throw new Error('Invalid value')
      const steps = (value - current.control.min) / current.control.step
      if (Math.abs(steps - Math.round(steps)) > 1e-7) throw new Error('Invalid increment')
      next[id] = value
    }
    requested = next
    for (const [id, value] of entries) {
      const current = byId.get(id)!
      if (current.control.applyMode === 'LIVE') current.write(value)
    }
    unranked ||= entries.some(([id]) => byId.get(id)?.control.integrity === 'GAMEPLAY')
  },
  activate(boundary: 'run'): void {
    if (boundary !== 'run') return
    for (const current of bindings) if (current.control.applyMode === 'NEXT_RUN') current.write(requested[current.control.id])
    unranked ||= bindings.some(current => current.control.integrity === 'GAMEPLAY' && current.read() !== current.control.default)
  },
}
