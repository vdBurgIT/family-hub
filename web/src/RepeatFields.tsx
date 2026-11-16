// The event sheet's repeat editor (rules in eventRepeat.ts). Controlled: the sheet keeps the state,
// so it knows whether the repeat was touched (an untouched rule is sent back as it came).
import { RR_DAYS, monthlyLabel, monthlyModes, repeatSummary, withFreq, type MonthlyMode, type RepeatForm, type RepeatFreq } from './eventRepeat.ts'
import { formatDate, t, tn } from './i18n.ts'

export type RepeatState = { form: RepeatForm; custom: boolean; touched: boolean }

const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0]
const dayName = (d: number, weekday: 'short' | 'long') => formatDate(new Date(2023, 0, 1 + d), { weekday })

function unitText(freq: RepeatFreq, n: number): string {
  if (freq === 'daily') return tn(n, 'day', 'days')
  if (freq === 'weekly') return tn(n, 'week', 'weeks')
  if (freq === 'monthly') return tn(n, 'month', 'months')
  return tn(n, 'year', 'years')
}

export function RepeatFields({ value, start, onChange }: { value: RepeatState; start: string; onChange: (next: RepeatState) => void }) {
  const { form, custom } = value
  const set = (patch: Partial<RepeatForm>) => onChange({ form: { ...form, ...patch }, custom: false, touched: true })
  const pickFreq = (freq: string) => {
    if (freq === 'custom') return
    onChange({ form: withFreq(custom ? { ...form, interval: 1, end: 'never' } : form, freq as RepeatFreq, start), custom: false, touched: true })
  }
  const summary = repeatSummary({ form, custom }, start)
  const modes = monthlyModes(start)
  return <>
    <div className="field">
      <label htmlFor="event-repeat">{t('Repeat')}</label>
      <select id="event-repeat" value={custom ? 'custom' : form.freq} onChange={e => pickFreq(e.target.value)}>
        {custom && <option value="custom" disabled>{t('Custom repeat')}</option>}
        <option value="">{t('Does not repeat')}</option>
        <option value="daily">{t('Daily')}</option>
        <option value="weekly">{t('Weekly')}</option>
        <option value="monthly">{t('Monthly')}</option>
        <option value="yearly">{t('Yearly')}</option>
      </select>
      {custom && <p className="field-hint">{t('This repeat was set up somewhere else and has options this editor can’t change. It stays as it is unless you pick another one.')}</p>}
    </div>
    {!custom && form.freq && <>
      <div className="field">
        <label htmlFor="event-repeat-interval">{t('Repeat every')}</label>
        <div className="chore-repeat-interval">
          <input id="event-repeat-interval" type="number" inputMode="numeric" min={1} max={9999} step={1} value={form.interval || ''} onChange={e => set({ interval: Number(e.target.value) })} />
          <span className="repeat-unit">{unitText(form.freq, form.interval || 1)}</span>
        </div>
      </div>
      {form.freq === 'weekly' && (
        <div className="field">
          <label id="event-repeat-days-label">{t('On')}</label>
          <div className="day-toggles" role="group" aria-labelledby="event-repeat-days-label">
            {MONDAY_FIRST.map(d => {
              const on = form.days.includes(d)
              return <button key={RR_DAYS[d]} type="button" className={on ? 'active' : ''} aria-pressed={on} aria-label={dayName(d, 'long')}
                onClick={() => set({ days: on ? form.days.filter(x => x !== d) : [...form.days, d] })}>{dayName(d, 'short')}</button>
            })}
          </div>
          {!form.days.length && <p className="field-hint">{t('No days picked: repeats on the weekday of its start date.')}</p>}
        </div>
      )}
      {form.freq === 'monthly' && (
        <div className="field">
          <label htmlFor="event-repeat-monthly">{t('Repeat on')}</label>
          <select id="event-repeat-monthly" value={modes.includes(form.monthly) ? form.monthly : 'day'} onChange={e => set({ monthly: e.target.value as MonthlyMode })}>
            {modes.map(m => <option key={m} value={m}>{monthlyLabel(m, start)}</option>)}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="event-repeat-end">{t('Ends')}</label>
        <select id="event-repeat-end" value={form.end} onChange={e => set({ end: e.target.value as RepeatForm['end'], until: form.until || start })}>
          <option value="never">{t('Never')}</option>
          <option value="on">{t('On a date')}</option>
          <option value="after">{t('After a number of times')}</option>
        </select>
      </div>
      {form.end === 'on' && (
        <div className="field">
          <label htmlFor="event-repeat-until">{t('Last date')}</label>
          <input id="event-repeat-until" type="date" min={start} value={form.until} onChange={e => set({ until: e.target.value })}
            aria-invalid={form.until < start || undefined} />
          {form.until < start && <p className="field-error" role="alert">{t('The last date has to be on or after the start.')}</p>}
        </div>
      )}
      {form.end === 'after' && (
        <div className="field">
          <label htmlFor="event-repeat-count">{t('Times')}</label>
          <input id="event-repeat-count" type="number" inputMode="numeric" min={1} max={9999} step={1} value={form.count || ''} onChange={e => set({ count: Number(e.target.value) })} />
        </div>
      )}
    </>}
    {summary && <p className="field-hint repeat-summary" aria-live="polite">{summary}</p>}
  </>
}
