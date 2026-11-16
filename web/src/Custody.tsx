// Family Hub: the kids' schedule on screen. The strip on each calendar day ("🏠 Kids here until
// 18:00"), the sheet a parent changes one date in, and the settings where the pattern is made.
// The pattern and its maths are in custody.ts; the server keeps it (server/src/routes/custody.ts).
import { useCallback, useEffect, useState } from 'react'
import { api } from './api.ts'
import { useApp } from './AppContext.tsx'
import { addDayKeys, custodyOn, custodyText, patternFrom, type CustodyDay, type CustodyKind, type CustodySchedule } from './custody.ts'
import { dateKey } from './date.ts'
import { useDialog } from './dialog.tsx'
import { InlineFaces } from './Face'
import { formatDate, msg, t, tm } from './i18n.ts'
import PickField from './PickField.tsx'
import Sheet from './Sheet.tsx'
import { formatTime } from './timeFormat.ts'

const KINDS: { value: CustodyKind; label: string }[] = [
  { value: 'here', label: msg('Here all day') },
  { value: 'arrive', label: msg('Come at…') },
  { value: 'leave', label: msg('Leave at…') },
  { value: 'away', label: msg('Not here') },
]
const HANDOVER = '18:00'
const dayOf = (kind: CustodyKind, time: string | null): CustodyDay =>
  kind === 'arrive' || kind === 'leave' ? { kind, time: time ?? HANDOVER } : { kind, time: null }
const keyDate = (key: string) => new Date(key + 'T00:00:00')

/** The family's schedule, read again whenever something changes. */
export function useCustody() {
  const { refreshTick } = useApp()
  const [schedule, setSchedule] = useState<CustodySchedule | null>(null)
  useEffect(() => { api.getCustody().then(r => setSchedule(r.schedule), () => {}) }, [refreshTick])
  const save = useCallback(async (next: CustodySchedule | null) => {
    const r = await api.setCustody(next)
    setSchedule(r.schedule)
    return r.schedule
  }, [])
  return { schedule, save }
}

/** The day's strip, or nothing when the kids aren't there. `short`: "Until 18:00" where it's narrow. */
export function CustodyStrip({ schedule, day, short, onTap }: { schedule: CustodySchedule | null; day: string; short?: boolean; onTap?: () => void }) {
  const { members } = useApp()
  if (!schedule) return null
  const d = custodyOn(schedule, day)
  const full = custodyText(schedule, d)
  const text = !short || d.kind === 'here' ? full : d.kind === 'arrive' ? t('From {time}', { time: formatTime(d.time!) }) : d.kind === 'leave' ? t('Until {time}', { time: formatTime(d.time!) }) : null
  const kids = members.filter(m => schedule.memberIds.includes(m.id))
  const inner = full ? <><span className="custody-mark" aria-hidden="true">🏠</span>{!short && kids.length > 0 && <InlineFaces who={kids} className="custody-faces" />}<span className="custody-text">{text}</span></> : null
  const cls = ['custody-strip', `custody-${d.kind}`, schedule.changes[day] ? 'custody-changed' : ''].join(' ')
  const said = full ?? t('{label}: not today', { label: schedule.label })
  if (onTap) return <button type="button" className={cls} onClick={onTap} aria-label={t('{state}. Change {day}', { state: said, day: formatDate(keyDate(day), { weekday: 'long', month: 'long', day: 'numeric' }) })}>{inner}</button>
  return <span className={cls} title={full ?? undefined}>{full && <span className="sr-only">{full}</span>}<span aria-hidden="true">{inner}</span></span>
}

function DayFields({ idBase, value, onChange }: { idBase: string; value: CustodyDay; onChange: (d: CustodyDay) => void }) {
  return (
    <div className="custody-day-fields">
      <select className="settings-select" id={idBase} value={value.kind} onChange={e => onChange(dayOf(e.target.value as CustodyKind, value.time))}>
        {KINDS.map(k => <option key={k.value} value={k.value}>{tm(k.label)}</option>)}
      </select>
      {value.time !== null && <input type="time" className="custody-time" aria-label={t('Time')} value={value.time} required
        onChange={e => e.target.value && onChange({ ...value, time: e.target.value })} />}
    </div>
  )
}

/** A parent changes one date (a holiday, a swap), or puts it back to the pattern. */
export function CustodyDaySheet({ schedule, day, onSave, onClose }: { schedule: CustodySchedule; day: string; onSave: (next: CustodySchedule) => Promise<unknown>; onClose: () => void }) {
  const usual = (() => { const { [day]: _, ...rest } = schedule.changes; return custodyOn({ ...schedule, changes: rest }, day) })()
  const [value, setValue] = useState<CustodyDay>(custodyOn(schedule, day))
  const [error, setError] = useState<string | null>(null)
  const put = async (changes: Record<string, CustodyDay>) => {
    try { await onSave({ ...schedule, changes }); onClose() } catch { setError(t("That couldn't be saved. Try again.")) }
  }
  const same = (a: CustodyDay, b: CustodyDay) => a.kind === b.kind && a.time === b.time
  const save = () => {
    const { [day]: _, ...rest } = schedule.changes
    return put(same(value, usual) ? rest : { ...rest, [day]: value })
  }
  return (
    <Sheet title={formatDate(keyDate(day), { weekday: 'long', month: 'long', day: 'numeric' })} onClose={onClose}
      actions={<button className="btn btn-primary btn-block" onClick={() => void save()}>{t('Save')}</button>}>
      {error && <p className="snap-empty" role="alert">{error}</p>}
      <div className="field">
        <label htmlFor="custody-day">{schedule.label}</label>
        <DayFields idBase="custody-day" value={value} onChange={setValue} />
      </div>
      <p className="settings-row-sub">{t('Usually: {state}', { state: custodyText(schedule, usual) ?? tm(KINDS[3].label) })}</p>
      {schedule.changes[day] && <div className="sheet-danger-zone">
        <button type="button" className="link-btn" onClick={() => { const { [day]: _, ...rest } = schedule.changes; void put(rest) }}>{t('Back to the usual schedule')}</button>
      </div>}
    </Sheet>
  )
}

const WEEK_OPTIONS = [1, 2, 3, 4]

/** Settings, Family: make the pattern, see and undo single-day changes. Parents' devices only. */
export function CustodySettings({ toast }: { toast: (m: string) => void }) {
  const { members, settings } = useApp()
  const dialog = useDialog()
  const { schedule, save } = useCustody()
  const [draft, setDraft] = useState<CustodySchedule | null>(null)
  const [changing, setChanging] = useState<string | null>(null)
  const [newDate, setNewDate] = useState('')
  useEffect(() => { setDraft(schedule) }, [schedule])

  const today = dateKey(new Date())
  if (!draft) return (
    <div className="settings-row">
      <div style={{ flex: 1 }}>
        <div className="settings-row-label">{t('No schedule yet')}</div>
        <div className="settings-row-sub">{t('Show on the calendar which days the kids are home, without an event filling every day.')}</div>
      </div>
      <button type="button" className="btn btn-secondary" style={{ flex: 'none' }}
        onClick={() => setDraft({ label: t('Kids here'), memberIds: members.filter(m => !m.grownUp).map(m => m.id), start: patternFrom(today, settings.weekStart), days: Array.from({ length: 14 }, () => dayOf('away', null)), changes: {} })}>
        {t('Make a schedule')}
      </button>
    </div>
  )

  const weeks = Math.ceil(draft.days.length / 7)
  const setWeeks = (n: number) => setDraft({ ...draft, days: Array.from({ length: n * 7 }, (_, i) => draft.days[i % draft.days.length]) })
  const setDay = (i: number, d: CustodyDay) => setDraft({ ...draft, days: draft.days.map((x, j) => j === i ? d : x) })
  const dirty = JSON.stringify(draft) !== JSON.stringify(schedule)
  const submit = async () => {
    try { await save(draft); toast(t('Saved: {name}', { name: draft.label })) } catch { toast(t("That couldn't be saved. Try again.")) }
  }
  const remove = async () => {
    if (!schedule) { setDraft(null); return }
    if (!await dialog.confirm({ title: t('Delete “{name}”?', { name: schedule.label }), body: t('The calendar stops showing which days the kids are home.'), confirmLabel: t('Delete'), danger: true })) return
    await save(null); setDraft(null)
  }
  const upcoming = Object.keys(draft.changes).filter(k => k >= today).sort()

  return (
    <div className="custody-settings">
      <div className="field">
        <label htmlFor="custody-label">{t('What the calendar says')}</label>
        <input id="custody-label" maxLength={40} value={draft.label} onChange={e => setDraft({ ...draft, label: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="custody-kids">{t('Whose schedule')}</label>
        <PickField id="custody-kids" label={t('Whose schedule')} multiple none={t('Nobody picked')} value={draft.memberIds} onChange={memberIds => setDraft({ ...draft, memberIds })}
          options={members.map(m => ({ value: m.id, label: m.name, lead: m.avatar }))} />
      </div>
      <div className="custody-row2">
        <div className="field">
          <label htmlFor="custody-weeks">{t('Repeats every')}</label>
          <select className="settings-select" id="custody-weeks" value={weeks} onChange={e => setWeeks(Number(e.target.value))}>
            {WEEK_OPTIONS.map(n => <option key={n} value={n}>{n === 1 ? t('Week') : t('{n} weeks', { n })}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="custody-start">{t('Week 1 starts')}</label>
          <input id="custody-start" type="date" value={draft.start} onChange={e => e.target.value && setDraft({ ...draft, start: patternFrom(e.target.value, settings.weekStart) })} />
        </div>
      </div>
      {Array.from({ length: weeks }, (_, w) => (
        <fieldset key={w} className="custody-week">
          <legend>{weeks > 1 ? t('Week {n}', { n: w + 1 }) : t('Every week')}</legend>
          {draft.days.slice(w * 7, w * 7 + 7).map((d, j) => {
            const i = w * 7 + j
            const key = addDayKeys(draft.start, i)
            return (
              <div key={i} className="custody-day-row">
                <label htmlFor={`custody-d${i}`}>{formatDate(keyDate(key), { weekday: 'long' })}<span className="settings-row-sub"> {formatDate(keyDate(key), { month: 'short', day: 'numeric' })}</span></label>
                <DayFields idBase={`custody-d${i}`} value={d} onChange={v => setDay(i, v)} />
              </div>
            )
          })}
        </fieldset>
      ))}
      <fieldset className="custody-week">
        <legend>{t('Changes for single days')}</legend>
        {!upcoming.length && <p className="settings-row-sub">{t('Holidays and swaps. You can also tap a day on the calendar.')}</p>}
        {upcoming.map(k => (
          <div key={k} className="custody-day-row">
            <span>{formatDate(keyDate(k), { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <button type="button" className="link-btn" style={{ flex: 'none' }} onClick={() => setChanging(k)}>{custodyText(draft, draft.changes[k]) ?? tm(KINDS[3].label)}</button>
          </div>
        ))}
        {schedule && <div className="custody-day-row">
          <input type="date" aria-label={t('Date')} value={newDate} min={today} onChange={e => setNewDate(e.target.value)} />
          <button type="button" className="btn btn-secondary" style={{ flex: 'none' }} disabled={!newDate || dirty} onClick={() => { setChanging(newDate); setNewDate('') }}>{t('Change this day')}</button>
        </div>}
      </fieldset>
      <button type="button" className="btn btn-primary" disabled={!dirty || !draft.label.trim()} onClick={() => void submit()}>{t('Save schedule')}</button>
      <div className="sheet-danger-zone">
        <button type="button" className="link-btn link-danger" onClick={() => void remove()}>{schedule ? t('Delete schedule') : t('Cancel')}</button>
      </div>
      {changing && schedule && <CustodyDaySheet schedule={schedule} day={changing} onSave={save} onClose={() => setChanging(null)} />}
    </div>
  )
}

/** One line for the board's Today card: "🏠 Kids here until 18:00", or nothing. */
export function CustodyToday({ schedule }: { schedule: CustodySchedule | null }) {
  if (!schedule) return null
  const text = custodyText(schedule, custodyOn(schedule, dateKey(new Date())))
  return text ? <li className="custody-today"><span aria-hidden="true">🏠 </span>{text}</li> : null
}
