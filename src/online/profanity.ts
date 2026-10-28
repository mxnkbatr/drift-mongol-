// Small client-side display-name filter (App Store Guideline 1.2). Not exhaustive by design.
const WORDS = [
  // English
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'whore', 'slut', 'nigg', 'fag', 'rape', 'porn', 'nazi', 'hitler', 'asshole', 'bastard',
  // Mongolian (Cyrillic)
  'пизда', 'пзда', 'бляд', 'хуй', 'гичий', 'новш', 'янхан', 'дүүлэ', 'шээс', 'баас', 'өгзөг', 'мангуу', 'тэнэг', 'гөлөг',
  // Mongolian (Latin transliteration)
  'pizda', 'pzda', 'blyad', 'huy', 'gichii', 'novsh', 'yanhan', 'duule', 'shees', 'ugzug', 'mangu', 'teneg', 'gulug',
]
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' }
const normalize = (s: string) => s.toLowerCase().replace(/[0-9@$]/g, c => LEET[c] ?? c).replace(/[^a-zа-яёөү]/g, '')
const NORMALIZED = WORDS.map(normalize).filter(w => w.length >= 3)

export function isProfane(name: string): boolean {
  const n = normalize(name)
  return NORMALIZED.some(w => n.includes(w))
}

/** Mask other players' names that fail the filter. */
export function safeName(name: string): string {
  return isProfane(name) ? '***' : name
}
