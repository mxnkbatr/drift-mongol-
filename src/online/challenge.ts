/**
 * Challenge links: `?vs=<token>` carries the challenger's score, name and day so a friend opening
 * the link sees the target before the first run. The token is plain base64url JSON (not a secret);
 * decoding is defensive because it comes from an arbitrary URL.
 */
export type Challenge = { score: number; name: string; day: string }

const MAX_SCORE = 2_000_000

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(token: string): string {
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function cleanName(name: string): string {
  // Strip control characters and collapse whitespace; names are always rendered as text.
  // eslint-disable-next-line no-control-regex
  return name.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16)
}

export function encodeChallenge(c: Challenge): string {
  return toBase64Url(JSON.stringify({ s: Math.max(0, Math.floor(c.score)), n: cleanName(c.name), d: c.day }))
}

export function decodeChallenge(token: string | null | undefined): Challenge | null {
  if (!token || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) return null
  try {
    const data = JSON.parse(fromBase64Url(token)) as { s?: unknown; n?: unknown; d?: unknown }
    const score = typeof data.s === 'number' && Number.isFinite(data.s) ? Math.floor(data.s) : -1
    if (score <= 0 || score > MAX_SCORE) return null
    const name = typeof data.n === 'string' ? cleanName(data.n) : ''
    const day = typeof data.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.d) ? data.d : ''
    return { score, name: name || '???', day }
  } catch {
    return null
  }
}

/** Build the shareable link from the current page, keeping any ingress path prefix. */
export function challengeUrl(c: Challenge, href: string): string {
  const url = new URL(href)
  url.search = ''
  url.hash = ''
  url.searchParams.set('vs', encodeChallenge(c))
  return url.toString()
}
