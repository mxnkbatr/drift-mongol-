import qrcode from 'qrcode-generator'

export type CardData = {
  title: string
  subtitle: string
  score: number
  scoreLabel: string
  lines: string[]
  rating: string
  cta: string
  url: string
  condition: string
  day: string
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Chunky outlined arcade text with a hard drop shadow. */
function arcadeText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, fill: string, shadow = '#1b1838'): void {
  ctx.font = `900 italic ${size}px Sora, "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.lineJoin = 'round'
  ctx.fillStyle = shadow
  ctx.fillText(text, x + size * 0.07, y + size * 0.09)
  ctx.lineWidth = Math.max(4, size * 0.14)
  ctx.strokeStyle = shadow
  ctx.strokeText(text, x, y)
  ctx.fillStyle = fill
  ctx.fillText(text, x, y)
}

/**
 * Render the 1200×675 share card: game name, score, rank, percentile, rating, day's condition and
 * a QR code + short link for the challenge. Pure canvas drawing (no DOM screenshots).
 */
export function drawShareCard(data: CardData): HTMLCanvasElement {
  const W = 1200
  const H = 675
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  // Night-city backdrop: gradient sky, skyline blocks, neon road stripes.
  const sky = ctx.createLinearGradient(0, 0, 0, H)
  sky.addColorStop(0, '#0a0b24')
  sky.addColorStop(0.6, '#2d1a5c')
  sky.addColorStop(1, '#ff5a8a')
  ctx.fillStyle = sky
  ctx.fillRect(0, 0, W, H)
  let seed = 7
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let x = 0; x < W; ) {
    const w = 40 + r() * 70
    const h = 120 + r() * 260
    ctx.fillStyle = '#15102e'
    ctx.fillRect(x, H - h - 60, w, h + 60)
    for (let wy = H - h - 40; wy < H - 70; wy += 22) {
      for (let wx = x + 8; wx < x + w - 10; wx += 16) {
        if (r() < 0.35) {
          ctx.fillStyle = r() < 0.7 ? '#ffcf7a' : '#8fd8ff'
          ctx.fillRect(wx, wy, 7, 10)
        }
      }
    }
    x += w + 4
  }
  ctx.fillStyle = '#0d0a1f'
  ctx.fillRect(0, H - 70, W, 70)
  ctx.save()
  ctx.globalAlpha = 0.9
  for (let i = 0; i < 9; i += 1) {
    ctx.fillStyle = i % 2 ? '#ff4fd8' : '#39e6ff'
    ctx.fillRect(0, H - 64 + i * 7, W, 2)
  }
  ctx.restore()
  // Panel.
  ctx.fillStyle = 'rgba(12,10,32,0.78)'
  roundRect(ctx, 48, 44, W - 96, H - 130, 28)
  ctx.fill()
  ctx.lineWidth = 6
  ctx.strokeStyle = '#ffd35c'
  ctx.stroke()
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'
  arcadeText(ctx, data.title, 90, 132, 64, '#ffd35c')
  ctx.font = '700 26px Sora, "Noto Sans SC", sans-serif'
  ctx.fillStyle = '#b9b3e6'
  ctx.fillText(data.subtitle, 94, 174)
  ctx.font = '800 30px Sora, "Noto Sans SC", sans-serif'
  ctx.fillStyle = '#39e6ff'
  ctx.fillText(data.scoreLabel, 94, 250)
  arcadeText(ctx, data.score.toLocaleString('en-US'), 88, 360, 118, '#ffffff', '#ff4fd8')
  if (data.rating) {
    ctx.save()
    ctx.translate(100, 400)
    ctx.rotate(-0.04)
    ctx.fillStyle = '#ff4fd8'
    roundRect(ctx, 0, 0, Math.min(560, 30 + data.rating.length * 30), 56, 12)
    ctx.fill()
    ctx.font = '900 italic 34px Sora, "Noto Sans SC", sans-serif'
    ctx.fillStyle = '#fff'
    ctx.fillText(data.rating, 16, 40)
    ctx.restore()
  }
  ctx.font = '800 30px Sora, "Noto Sans SC", sans-serif'
  data.lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 ? '#ffd35c' : '#f1eeff'
    ctx.fillText(line, 94, 500 + i * 42)
  })
  // QR code block.
  const qr = qrcode(0, 'M')
  qr.addData(data.url)
  qr.make()
  const n = qr.getModuleCount()
  const size = 250
  const cell = Math.floor(size / (n + 4))
  const qs = cell * (n + 4)
  const qx = W - 96 - qs - 24
  const qy = 110
  ctx.fillStyle = '#ffffff'
  roundRect(ctx, qx, qy, qs, qs, 14)
  ctx.fill()
  ctx.fillStyle = '#15102e'
  for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (qr.isDark(y, x)) ctx.fillRect(qx + (x + 2) * cell, qy + (y + 2) * cell, cell, cell)
  ctx.textAlign = 'center'
  ctx.font = '900 italic 30px Sora, "Noto Sans SC", sans-serif'
  ctx.fillStyle = '#ffd35c'
  ctx.fillText(data.cta, qx + qs / 2, qy + qs + 48)
  ctx.font = '700 22px Sora, "Noto Sans SC", sans-serif'
  ctx.fillStyle = '#b9b3e6'
  ctx.fillText(`${data.day} · ${data.condition}`, qx + qs / 2, qy + qs + 84)
  let short = data.url.replace(/^https?:\/\//, '')
  if (short.length > 40) short = `${short.slice(0, 38)}…`
  ctx.font = '600 18px ui-monospace, Menlo, monospace'
  ctx.fillStyle = '#8e88c0'
  ctx.fillText(short, qx + qs / 2, qy + qs + 116)
  return c
}

export function canvasBlob(c: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => c.toBlob(b => resolve(b), 'image/png'))
}
