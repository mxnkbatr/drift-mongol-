import en from '../i18n/en.json'
import zh from '../i18n/zh-CN.json'
import mn from '../i18n/mn.json'
import type { Locale } from './save'

export type Dictionary = Record<string, string>
const DICTIONARIES: Record<Locale, Dictionary> = { en, 'zh-CN': zh, mn }

/** Map a browser locale list to Mongolian or Simplified Chinese, otherwise English. */
export function detectLocale(languages: readonly string[] | undefined): Locale {
  const first = (languages ?? []).find(Boolean) ?? ''
  const normalized = first.toLowerCase()
  if (normalized.startsWith('mn') || normalized.startsWith('mon')) return 'mn'
  return normalized.startsWith('zh') ? 'zh-CN' : 'en'
}

/** A saved player choice always wins over browser detection. */
export function resolveLocale(saved: Locale | '', languages: readonly string[] | undefined): Locale {
  return saved === 'en' || saved === 'zh-CN' || saved === 'mn' ? saved : detectLocale(languages)
}

export class I18n {
  locale: Locale
  private listeners = new Set<(locale: Locale) => void>()

  constructor(locale: Locale) {
    this.locale = locale
    document.documentElement.lang = locale
  }

  /** Look up `key`, replacing `{name}` placeholders. Missing keys render the key so gaps are visible. */
  t(key: string, vars: Record<string, string | number> = {}): string {
    const text = DICTIONARIES[this.locale][key] ?? DICTIONARIES.en[key] ?? key
    return text.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`))
  }

  set(locale: Locale): void {
    if (locale === this.locale) return
    this.locale = locale
    document.documentElement.lang = locale
    for (const fn of this.listeners) fn(locale)
  }

  onChange(fn: (locale: Locale) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export const DICTIONARY_KEYS = { en: Object.keys(en), zh: Object.keys(zh), mn: Object.keys(mn) }
