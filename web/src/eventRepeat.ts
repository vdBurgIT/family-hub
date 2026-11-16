// The event sheet's repeat editor: the RRULE subset it can show and change, and the sentence that
// sums a rule up. A rule it can't show (from Google, iCloud or anywhere else) is "custom": shown as
// a summary and sent back untouched unless someone picks another repeat.
// Dates are 'YYYY-MM-DD' keys (the event's start date in the sheet).
import { formatDate, intlLocale, t, tn } from './i18n.ts'

export const RR_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
export type RepeatFreq = '' | 'daily' | 'weekly' | 'monthly' | 'yearly'
/** Monthly: on the start's day of the month, its nth weekday (2nd Tuesday), or its last weekday. */
export type MonthlyMode = 'day' | 'nth' | 'last'
export type RepeatForm = {
  freq: RepeatFreq
  interval: number
  days: number[] // weekly: 0 = Sunday ... 6 = Saturday
  monthly: MonthlyMode
  end: 'never' | 'on' | 'after'
  until: string // 'YYYY-MM-DD', the last day it can happen
  count: number
  wkst?: string // kept as it came
}
export type ParsedRepeat = { form: RepeatForm; custom: boolean }

const key = (s: string) => s.slice(0, 10)
const at = (start: string) => new Date(`${key(start)}T12:00:00Z`)

/** What a start date gives a monthly repeat: its weekday, day, which of its weekday it is (1-4,
 * null for a 5th) and whether it's the last one of the month. */
export function startFacts(start: string) {
  const d = at(start)
  const day = d.getUTCDate()
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  const nth = Math.ceil(day / 7)
  return { weekday: d.getUTCDay(), day, month: d.getUTCMonth() + 1, nth: nth <= 4 ? nth : null, last: day + 7 > daysInMonth }
}

/** The monthly choices a start date offers: always its day; its nth weekday up to the 4th; the last one when it is. */
export function monthlyModes(start: string): MonthlyMode[] {
  const f = startFacts(start)
  return ['day', ...(f.nth ? ['nth' as const] : []), ...(f.last ? ['last' as const] : [])]
}

export function emptyForm(start: string): RepeatForm {
  return { freq: '', interval: 1, days: [startFacts(start).weekday], monthly: 'day', end: 'never', until: '', count: 10 }
}

/** The form for a newly picked frequency, keeping what still fits (interval, end). */
export function withFreq(form: RepeatForm, freq: RepeatFreq, start: string): RepeatForm {
  const base = { ...emptyForm(start), interval: form.interval, end: form.end, until: form.until, count: form.count }
  return { ...base, freq, days: form.freq === 'weekly' && form.days.length ? form.days : base.days }
}

/** UNTIL as the day it ends on. A UTC time (what iCloud writes) is read in the family's timezone. */
function untilDate(value: string, tz?: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value)
  if (!m) return null
  const date = `${m[1]}-${m[2]}-${m[3]}`
  if (!m[8]) return date
  const instant = new Date(`${date}T${m[5]}:${m[6]}:${m[7]}Z`)
  if (Number.isNaN(instant.getTime())) return null
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant)
  } catch {
    return date
  }
}

const positive = (s: string) => /^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= 9999

export function parseRepeat(rule: string | null | undefined, start: string, tz?: string): ParsedRepeat {
  const form = emptyForm(start)
  if (!rule) return { form, custom: false }
  const facts = startFacts(start)
  const parts = rule.replace(/^RRULE:/i, '').split(';').filter(Boolean).map(p => p.trim().toUpperCase().split('='))
  const values = new Map<string, string>()
  let custom = false
  for (const [name, value = '', extra] of parts) {
    if (values.has(name) || extra !== undefined) custom = true
    values.set(name, value)
  }
  const freq = values.get('FREQ')?.toLowerCase()
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly' && freq !== 'yearly') return { form, custom: true }
  form.freq = freq
  for (const [name, value] of values) {
    if (name === 'FREQ') continue
    if (name === 'INTERVAL' && positive(value)) form.interval = Number(value)
    else if (name === 'COUNT' && positive(value) && !values.has('UNTIL')) { form.end = 'after'; form.count = Number(value) }
    else if (name === 'UNTIL' && !values.has('COUNT') && untilDate(value, tz)) { form.end = 'on'; form.until = untilDate(value, tz)! }
    else if (name === 'WKST' && RR_DAYS.includes(value)) form.wkst = value
    else if (name === 'BYDAY' && freq === 'weekly' && value.split(',').every(d => RR_DAYS.includes(d))) {
      form.days = [...new Set(value.split(',').map(d => RR_DAYS.indexOf(d)))].sort((a, b) => a - b)
    } else if (name === 'BYDAY' && freq === 'monthly' && value === `${facts.nth}${RR_DAYS[facts.weekday]}`) form.monthly = 'nth'
    else if (name === 'BYDAY' && freq === 'monthly' && value === `-1${RR_DAYS[facts.weekday]}` && facts.last) form.monthly = 'last'
    else if (name === 'BYMONTHDAY' && freq === 'monthly' && value === String(facts.day)) form.monthly = 'day'
    else if (name === 'BYMONTH' && freq === 'yearly' && value === String(facts.month)) continue
    else if (name === 'BYMONTHDAY' && freq === 'yearly' && value === String(facts.day)) continue
    else custom = true
  }
  return { form, custom }
}

/** The rule for a form, from the event's start date. UNTIL is the last day: a date for an all-day
 * event, its 23:59:59 otherwise (the server writes it in the form the calendar needs). */
export function buildRepeat(form: RepeatForm, start: string, allDay: boolean): string | null {
  if (!form.freq) return null
  const facts = startFacts(start)
  const parts: [string, string][] = [['FREQ', form.freq.toUpperCase()]]
  if (form.interval > 1) parts.push(['INTERVAL', String(form.interval)])
  if (form.freq === 'weekly') {
    const days = form.days.length ? form.days : [facts.weekday]
    parts.push(['BYDAY', [...days].sort((a, b) => (a + 6) % 7 - (b + 6) % 7).map(d => RR_DAYS[d]).join(',')])
    if (form.wkst) parts.push(['WKST', form.wkst])
  }
  if (form.freq === 'monthly') {
    const mode = monthlyModes(start).includes(form.monthly) ? form.monthly : 'day'
    const weekday = RR_DAYS[facts.weekday]
    parts.push(mode === 'day' ? ['BYMONTHDAY', String(facts.day)] : ['BYDAY', (mode === 'last' ? '-1' : String(facts.nth)) + weekday])
  }
  if (form.end === 'on' && /^\d{4}-\d{2}-\d{2}$/.test(form.until)) parts.push(['UNTIL', form.until.replace(/-/g, '') + (allDay ? '' : 'T235959')])
  if (form.end === 'after') parts.push(['COUNT', String(Math.max(1, Math.min(9999, Math.round(form.count) || 1)))])
  return parts.map(p => p.join('=')).join(';')
}

/** Whether the form can be saved: a whole interval and count, an end date on or after the start. */
export function validRepeat(form: RepeatForm, start: string): boolean {
  if (!form.freq) return true
  return Number.isInteger(form.interval) && form.interval >= 1 && form.interval <= 9999
    && (form.end !== 'after' || (Number.isInteger(form.count) && form.count >= 1 && form.count <= 9999))
    && (form.end !== 'on' || (/^\d{4}-\d{2}-\d{2}$/.test(form.until) && form.until >= key(start)))
}

const weekdayName = (d: number, weekday: 'short' | 'long') => formatDate(new Date(2023, 0, 1 + d), { weekday })

/** "Every month on the second Tuesday" for the start's nth (or last) weekday. */
function monthlyWeekdayText(mode: MonthlyMode, interval: number, weekday: string, nth: number | null): string {
  if (mode === 'last') return tn(interval, 'Every month on the last {weekday}', 'Every {n} months on the last {weekday}', { weekday })
  if (nth === 1) return tn(interval, 'Every month on the first {weekday}', 'Every {n} months on the first {weekday}', { weekday })
  if (nth === 2) return tn(interval, 'Every month on the second {weekday}', 'Every {n} months on the second {weekday}', { weekday })
  if (nth === 3) return tn(interval, 'Every month on the third {weekday}', 'Every {n} months on the third {weekday}', { weekday })
  return tn(interval, 'Every month on the fourth {weekday}', 'Every {n} months on the fourth {weekday}', { weekday })
}

/** The choice label for a monthly mode on this start date ("On day 15", "On the second Tuesday"). */
export function monthlyLabel(mode: MonthlyMode, start: string): string {
  const f = startFacts(start)
  const weekday = weekdayName(f.weekday, 'long')
  if (mode === 'day') return t('On day {day}', { day: f.day })
  if (mode === 'last') return t('On the last {weekday}', { weekday })
  if (f.nth === 1) return t('On the first {weekday}', { weekday })
  if (f.nth === 2) return t('On the second {weekday}', { weekday })
  if (f.nth === 3) return t('On the third {weekday}', { weekday })
  return t('On the fourth {weekday}', { weekday })
}

/** One sentence for a repeat: "Every 2 weeks on Mon and Thu, until Jun 1". '' when it doesn't repeat. */
export function repeatSummary(parsed: ParsedRepeat, start: string): string {
  if (parsed.custom) return t('Custom repeat')
  const { form } = parsed
  if (!form.freq) return ''
  const n = form.interval
  const f = startFacts(start)
  let text: string
  if (form.freq === 'daily') text = tn(n, 'Every day', 'Every {n} days')
  else if (form.freq === 'weekly') {
    const days = (form.days.length ? form.days : [f.weekday]).slice().sort((a, b) => (a + 6) % 7 - (b + 6) % 7).map(d => weekdayName(d, 'short'))
    text = tn(n, 'Every week on {days}', 'Every {n} weeks on {days}', { days: new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(days) })
  } else if (form.freq === 'monthly') {
    const mode = monthlyModes(start).includes(form.monthly) ? form.monthly : 'day'
    text = mode === 'day' ? tn(n, 'Every month on day {day}', 'Every {n} months on day {day}', { day: f.day }) : monthlyWeekdayText(mode, n, weekdayName(f.weekday, 'long'), f.nth)
  } else text = tn(n, 'Every year on {date}', 'Every {n} years on {date}', { date: formatDate(at(start), { month: 'long', day: 'numeric', timeZone: 'UTC' }) })
  if (form.end === 'on' && form.until) {
    const sameYear = form.until.slice(0, 4) === key(start).slice(0, 4)
    return t('{repeat}, until {date}', { repeat: text, date: formatDate(at(form.until), { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }), timeZone: 'UTC' }) })
  }
  if (form.end === 'after') return tn(form.count, '{repeat}, {n} time', '{repeat}, {n} times', { repeat: text })
  return text
}
