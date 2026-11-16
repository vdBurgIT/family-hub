// A timed event's start and end, as people read them on the calendar and the board: "15:00 – 16:30".
// An event over more than one day names the day on the side that isn't `dayKey`, so a weekend
// stay reads "Fri 17:00 – Mon 09:00" wherever it shows, instead of running to or from midnight.
import { zonedDayKey } from './date.ts'
import { intlLocale } from './i18n.ts'
import { formatTime } from './timeFormat.ts'

const weekdays = new Map<string, Intl.DateTimeFormat>()

function weekday(iso: string, tz: string): string {
  const key = `${intlLocale()}\u0000${tz}`
  let f = weekdays.get(key)
  if (!f) weekdays.set(key, f = new Intl.DateTimeFormat(intlLocale(), { timeZone: tz, weekday: 'short' }))
  return f.format(new Date(iso))
}

/** "15:00 – 16:30", or with the weekday on a side that falls on another day than `dayKey`
 * (YYYY-MM-DD in `tz`). An event without length shows its start only. */
export function eventSpan(ev: { start: string; end: string }, dayKey: string, tz: string): string {
  const start = formatTime(ev.start, tz)
  if (!ev.end || Date.parse(ev.end) <= Date.parse(ev.start)) return start
  const end = formatTime(ev.end, tz)
  const startDay = zonedDayKey(ev.start, tz), endDay = zonedDayKey(ev.end, tz)
  const from = startDay === dayKey ? start : `${weekday(ev.start, tz)} ${start}`
  const to = endDay === dayKey || endDay === startDay ? end : `${weekday(ev.end, tz)} ${end}`
  return `${from} – ${to}`
}
