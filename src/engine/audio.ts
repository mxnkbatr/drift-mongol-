/**
 * Web Audio mixer with music and SFX buses. Everything is synthesized at runtime (no audio files):
 * a looping engine voice driven by speed/throttle, tyre screech from filtered noise, an original
 * synthwave loop that intensifies with heat, and punchy arcade SFX. Call `unlock()` from a gesture.
 */
export type Sfx = 'ui' | 'go' | 'mult' | 'bank' | 'lost' | 'crash' | 'clip' | 'nearMiss' | 'heat' | 'tick' | 'end' | 'best' | 'count'

export class Audio {
  readonly ctx: AudioContext
  private master: GainNode
  private music: GainNode
  private sfx: GainNode
  private noise: AudioBuffer
  private engine?: { a: OscillatorNode; b: OscillatorNode; filter: BiquadFilterNode; gain: GainNode }
  private screech?: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode }
  private rain?: { src: AudioBufferSourceNode; gain: GainNode }
  private musicOn = false
  private musicTimer = 0
  private nextBeat = 0
  private beat = 0
  /** 0..3: music layers added as the heat rises. */
  intensity = 0

  constructor() {
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.music = this.ctx.createGain()
    this.sfx = this.ctx.createGain()
    const comp = this.ctx.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.ratio.value = 4
    this.music.connect(this.master)
    this.sfx.connect(this.master)
    this.master.connect(comp).connect(this.ctx.destination)
    const len = this.ctx.sampleRate * 2
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = this.noise.getChannelData(0)
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1
  }

  unlock(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  setVolumes(music: number, sfx: number, muted = false): void {
    const t = this.ctx.currentTime
    this.music.gain.setTargetAtTime(muted ? 0 : music * 0.5, t, 0.05)
    this.sfx.gain.setTargetAtTime(muted ? 0 : sfx * 0.85, t, 0.05)
  }

  // ─── continuous voices ────────────────────────────────────────────────
  private ensureVoices(): void {
    if (this.engine || this.ctx.state !== 'running') return
    const a = this.ctx.createOscillator()
    const b = this.ctx.createOscillator()
    a.type = 'sawtooth'
    b.type = 'square'
    const filter = this.ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.Q.value = 3
    const gain = this.ctx.createGain()
    gain.gain.value = 0
    a.connect(filter)
    b.connect(filter)
    filter.connect(gain).connect(this.sfx)
    a.start()
    b.start()
    this.engine = { a, b, filter, gain }
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    src.loop = true
    const sf = this.ctx.createBiquadFilter()
    sf.type = 'bandpass'
    sf.Q.value = 7
    sf.frequency.value = 1300
    const sg = this.ctx.createGain()
    sg.gain.value = 0
    src.connect(sf).connect(sg).connect(this.sfx)
    src.start()
    this.screech = { src, filter: sf, gain: sg }
    const rs = this.ctx.createBufferSource()
    rs.buffer = this.noise
    rs.loop = true
    const rf = this.ctx.createBiquadFilter()
    rf.type = 'lowpass'
    rf.frequency.value = 2400
    const rg = this.ctx.createGain()
    rg.gain.value = 0
    rs.connect(rf).connect(rg).connect(this.sfx)
    rs.start()
    this.rain = { src: rs, gain: rg }
  }

  /** Update the engine and tyre voices (call every frame). `on` = false fades them out. */
  drive(on: boolean, speed: number, throttle: number, slip: number, raining: boolean): void {
    this.ensureVoices()
    if (!this.engine || !this.screech || !this.rain) return
    const t = this.ctx.currentTime
    const gears = [0, 11, 19, 27, 35, 50]
    let g = 1
    while (g < gears.length - 1 && speed > gears[g]) g += 1
    const frac = Math.min(1, Math.max(0, (speed - gears[g - 1]) / (gears[g] - gears[g - 1])))
    const rpm = 0.25 + frac * 0.75
    const freq = 42 + rpm * 95 + g * 6 + throttle * 8
    this.engine.a.frequency.setTargetAtTime(freq, t, 0.04)
    this.engine.b.frequency.setTargetAtTime(freq * 0.502, t, 0.04)
    this.engine.filter.frequency.setTargetAtTime(380 + rpm * 1300 + throttle * 700, t, 0.05)
    this.engine.gain.gain.setTargetAtTime(on ? 0.055 + throttle * 0.05 : 0, t, 0.08)
    const s = on ? Math.min(1, Math.max(0, (Math.abs(slip) - 8) / 35)) * Math.min(1, speed / 10) : 0
    this.screech.gain.gain.setTargetAtTime(s * 0.16, t, 0.05)
    this.screech.filter.frequency.setTargetAtTime(1100 + s * 900 + Math.sin(t * 23) * 120, t, 0.03)
    this.rain.gain.gain.setTargetAtTime(raining ? 0.05 : 0, t, 0.4)
  }

  // ─── one-shots ─────────────────────────────────────────────────────────
  private tone(freq: number, end: number, dur: number, type: OscillatorType, vol: number, delay = 0, bus: GainNode = this.sfx): void {
    const t = this.ctx.currentTime + delay
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = type
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(end, 20), t + dur)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    o.connect(g).connect(bus)
    o.start(t)
    o.stop(t + dur + 0.05)
  }

  private burst(dur: number, vol: number, freq: number, type: BiquadFilterType = 'lowpass', delay = 0, bus: GainNode = this.sfx): void {
    const t = this.ctx.currentTime + delay
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise
    const f = this.ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    src.connect(f).connect(g).connect(bus)
    src.start(t, Math.random())
    src.stop(t + dur + 0.05)
  }

  play(name: Sfx, level = 1): void {
    if (this.ctx.state !== 'running') return
    switch (name) {
      case 'ui': this.tone(660, 720, 0.06, 'triangle', 0.16); break
      case 'count': this.tone(520, 520, 0.12, 'square', 0.12); break
      case 'go': this.tone(880, 880, 0.1, 'square', 0.14); this.tone(1320, 1320, 0.28, 'square', 0.12, 0.08); break
      case 'mult': {
        const f = 440 * Math.pow(2, Math.min(level, 10) / 8)
        this.tone(f, f * 1.5, 0.12, 'square', 0.1)
        this.tone(f * 2, f * 2, 0.08, 'sine', 0.08, 0.05)
        break
      }
      case 'bank': {
        const notes = [523, 659, 784, 1047, 1319, 1568]
        const n = 2 + Math.min(level, 6)
        for (let i = 0; i < n; i += 1) this.tone(notes[i % 6] * (i >= 6 ? 2 : 1), notes[i % 6] * 1.01, 0.18, 'triangle', 0.16, i * 0.055)
        this.burst(0.25, 0.12, 6000, 'highpass', 0.02)
        break
      }
      case 'lost': this.tone(330, 80, 0.45, 'sawtooth', 0.14); this.tone(220, 60, 0.5, 'square', 0.08, 0.05); break
      case 'crash': this.burst(0.35, 0.5 * Math.min(1, 0.4 + level), 900); this.tone(110, 40, 0.3, 'sine', 0.4); break
      case 'clip': this.tone(1200, 2400, 0.1, 'triangle', 0.14); this.tone(1800, 1800, 0.25, 'sine', 0.12, 0.07); this.burst(0.3, 0.1, 3000, 'bandpass'); break
      case 'nearMiss': this.burst(0.35, 0.22, 1500, 'bandpass'); this.tone(700, 1400, 0.18, 'triangle', 0.1, 0.05); break
      case 'heat': [0, 0.14, 0.28].forEach((d, i) => this.tone(600 + i * 200, 900 + i * 200, 0.12, 'square', 0.12, d)); break
      case 'tick': this.tone(1000, 1000, 0.05, 'square', 0.08); break
      case 'end': this.tone(392, 392, 0.4, 'square', 0.14); this.tone(523, 523, 0.7, 'square', 0.14, 0.18); break
      case 'best': [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, f, 0.22, 'triangle', 0.18, i * 0.09)); break
    }
  }

  // ─── music: original synthwave loop, 116 BPM, scheduled ahead ─────────
  startMusic(): void {
    if (this.musicOn) return
    this.musicOn = true
    this.nextBeat = this.ctx.currentTime + 0.1
    const spb = 60 / 116 / 4 // sixteenth notes
    // i – VI – III – VII in A minor, voiced for a driving bass arpeggio.
    const roots = [110, 87.31, 130.81, 98]
    const arp = [0, 12, 7, 12, 3, 12, 7, 15]
    const tick = () => {
      if (!this.musicOn) return
      while (this.nextBeat < this.ctx.currentTime + 0.12) {
        const step = this.beat % 16
        const bar = Math.floor(this.beat / 16) % 4
        const t = this.nextBeat - this.ctx.currentTime
        const root = roots[bar]
        const lvl = this.intensity
        // Bass arpeggio on every eighth (sixteenths from heat 2).
        if (step % 2 === 0 || lvl >= 2) this.tone(root * Math.pow(2, arp[step % 8] / 12), root * Math.pow(2, arp[step % 8] / 12), spb * 1.6, 'sawtooth', 0.05, t, this.music)
        // Kick on quarters, snare-ish noise on 2 and 4, hats from heat 1.
        if (step % 4 === 0) this.tone(150, 42, 0.22, 'sine', 0.35, t, this.music)
        if (step === 4 || step === 12) this.burst(0.16, 0.14, 1800, 'bandpass', t, this.music)
        if (lvl >= 1 && step % 2 === 1) this.burst(0.04, 0.06, 7000, 'highpass', t, this.music)
        // Lead pad stab each bar from heat 1, octave up in the final rush.
        if (step === 0 && lvl >= 1) {
          const mul = lvl >= 3 ? 4 : 2
          for (const iv of [0, 3, 7]) this.tone(root * mul * Math.pow(2, iv / 12), root * mul * Math.pow(2, iv / 12), spb * 12, 'triangle', 0.03, t, this.music)
        }
        this.beat += 1
        this.nextBeat += spb
      }
      this.musicTimer = window.setTimeout(tick, 30)
    }
    tick()
  }

  stopMusic(): void {
    this.musicOn = false
    clearTimeout(this.musicTimer)
  }
}
