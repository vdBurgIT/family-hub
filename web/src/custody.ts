// Family Hub: the kids' schedule (server/src/routes/custody.ts). One repeating pattern of days from
// `start`, plus changes for single dates; the calendar shows the state of each date as a strip
// instead of all-day events. Dates are YYYY-MM-DD keys (date.ts dateKey), counted in whole days.
import { t } from './i18n.ts'
import { formatTime } from './timeFormat.ts'

export type CustodyKind = 'here' | 'away' | 'arrive' | 'leave'
export type CustodyDay = { kind: CustodyKind; time: string | null }
export type CustodySchedule = {
  label: string
  memberIds: string[]
  start: string
  days: CustodyDay[]
  changes: Record<string, CustodyDay>
}

const DAY_MS = 86_400_000
const dayNumber = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / DAY_MS
const keyOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10)

/** Where the kids are on a date: its change, else the pattern's day. */
export function custodyOn(s: CustodySchedule, key: string): CustodyDay {
  const change = s.changes[key]
  if (change) return change
  const n = s.days.length
  const i = (((dayNumber(key) - dayNumber(s.start)) % n) + n) % n
  return s.days[i]
}

/** The strip's words for a day, or null when the kids aren't there. */
export function custodyText(s: CustodySchedule, d: CustodyDay): string | null {
  switch (d.kind) {
    case 'here': return s.label
    case 'arrive': return t('{label} from {time}', { label: s.label, time: formatTime(d.time ?? '00:00') })
    case 'leave': return t('{label} until {time}', { label: s.label, time: formatTime(d.time ?? '00:00') })
    default: return null
  }
}

/** The week's first day (0 Sunday, 1 Monday) on or before a date: where a new pattern starts. */
export function patternFrom(key: string, weekStart: 0 | 1): string {
  const n = dayNumber(key)
  const weekday = new Date(n * DAY_MS).getUTCDay()
  return keyOf(n - ((weekday - weekStart + 7) % 7))
}

/** The date `i` days after `key`. */
export const addDayKeys = (key: string, i: number) => keyOf(dayNumber(key) + i)

const H: CustodyDay = { kind: 'here', time: null }
const A: CustodyDay = { kind: 'away', time: null }
/** The demo family's schedule: two weeks from this Monday, short weekend then long weekend. */
export function demoCustody(): CustodySchedule {
  const today = new Date()
  const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const arrive: CustodyDay = { kind: 'arrive', time: '18:00' }, leave: CustodyDay = { kind: 'leave', time: '18:00' }
  return { label: t('Kids here'), memberIds: [], start: patternFrom(key, 1), days: [H, leave, A, A, arrive, H, H, H, leave, A, A, A, A, arrive], changes: {} }
}
