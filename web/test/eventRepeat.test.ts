import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRepeat, emptyForm, monthlyLabel, monthlyModes, parseRepeat, repeatSummary, startFacts, validRepeat, withFreq } from '../src/eventRepeat.ts'

// 2026-06-09 is the second Tuesday of June; 2026-07-31 the last (and 5th) Friday of July.
const TUE = '2026-06-09'
const LAST_FRI = '2026-07-31'

test('eventRepeat: a start date gives its weekday, nth weekday and whether it is the last', () => {
  assert.deepEqual(startFacts(TUE), { weekday: 2, day: 9, month: 6, nth: 2, last: false })
  assert.deepEqual(startFacts(LAST_FRI), { weekday: 5, day: 31, month: 7, nth: null, last: true })
  assert.deepEqual(monthlyModes(TUE), ['day', 'nth'])
  assert.deepEqual(monthlyModes(LAST_FRI), ['day', 'last'])
  assert.deepEqual(monthlyModes('2026-06-23'), ['day', 'nth'], '4th Tuesday, June has 30 days: 23 + 7 = 30 is still June')
  assert.deepEqual(monthlyModes('2026-06-24'), ['day', 'nth', 'last'])
})

test('eventRepeat: rules the editor shows round trip unchanged', () => {
  for (const [rule, start, allDay] of [
    ['FREQ=DAILY', TUE, false],
    ['FREQ=DAILY;INTERVAL=3;COUNT=8', TUE, false],
    ['FREQ=WEEKLY;BYDAY=TU', TUE, false],
    ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20260901T235959', TUE, false],
    ['FREQ=WEEKLY;BYDAY=MO,WE,FR;WKST=SU', TUE, true],
    ['FREQ=MONTHLY;BYMONTHDAY=9', TUE, false],
    ['FREQ=MONTHLY;BYDAY=2TU', TUE, false],
    ['FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR;UNTIL=20271231', LAST_FRI, true],
    ['FREQ=YEARLY', TUE, true],
  ] as const) {
    const parsed = parseRepeat(rule, start)
    assert.equal(parsed.custom, false, rule)
    assert.equal(buildRepeat(parsed.form, start, allDay), rule)
  }
})

test('eventRepeat: plain frequencies from the old menu and from elsewhere read as the start implies', () => {
  assert.deepEqual(parseRepeat('FREQ=WEEKLY', TUE).form.days, [2])
  assert.equal(parseRepeat('RRULE:FREQ=MONTHLY', TUE).form.monthly, 'day')
  assert.equal(buildRepeat(parseRepeat('FREQ=MONTHLY', TUE).form, TUE, false), 'FREQ=MONTHLY;BYMONTHDAY=9')
  // iCloud's order and a UTC UNTIL: read in the family's timezone (21:59:59Z is 23:59:59 in Amsterdam).
  const icloud = parseRepeat('FREQ=WEEKLY;UNTIL=20260901T215959Z;BYDAY=TU', TUE, 'Europe/Amsterdam')
  assert.equal(icloud.custom, false)
  assert.equal(icloud.form.until, '2026-09-01')
  assert.equal(parseRepeat('FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=9', TUE).custom, false)
})

test('eventRepeat: rules the editor cannot show are custom', () => {
  for (const rule of [
    'FREQ=HOURLY',
    'FREQ=MONTHLY;BYMONTHDAY=1,15',
    'FREQ=MONTHLY;BYDAY=3TU', // not this start's Tuesday
    'FREQ=MONTHLY;BYDAY=-1TU', // TUE isn't the last one
    'FREQ=WEEKLY;BYDAY=1MO',
    'FREQ=DAILY;BYDAY=MO,TU',
    'FREQ=YEARLY;BYMONTH=1,7',
    'FREQ=WEEKLY;COUNT=3;UNTIL=20260901',
    'FREQ=DAILY;BYSETPOS=1',
  ]) assert.equal(parseRepeat(rule, TUE).custom, true, rule)
  assert.equal(repeatSummary(parseRepeat('FREQ=MONTHLY;BYMONTHDAY=1,15', TUE), TUE), 'Custom repeat')
})

test('eventRepeat: weekly days default to the start, are sorted Monday first, and an empty pick falls back', () => {
  const form = withFreq(emptyForm(TUE), 'weekly', TUE)
  assert.deepEqual(form.days, [2])
  assert.equal(buildRepeat({ ...form, days: [0, 4, 1] }, TUE, false), 'FREQ=WEEKLY;BYDAY=MO,TH,SU')
  assert.equal(buildRepeat({ ...form, days: [] }, TUE, false), 'FREQ=WEEKLY;BYDAY=TU')
  assert.equal(buildRepeat(withFreq(form, '', TUE), TUE, false), null)
})

test('eventRepeat: monthly follows the start date, falling back to its day when the choice no longer fits', () => {
  const form = { ...withFreq(emptyForm(TUE), 'monthly', TUE), monthly: 'nth' as const }
  assert.equal(buildRepeat(form, TUE, false), 'FREQ=MONTHLY;BYDAY=2TU')
  assert.equal(buildRepeat(form, '2026-06-17', false), 'FREQ=MONTHLY;BYDAY=3WE', 'moving the start moves the weekday')
  assert.equal(buildRepeat(form, LAST_FRI, false), 'FREQ=MONTHLY;BYMONTHDAY=31', 'no 5th weekday choice')
  assert.equal(buildRepeat({ ...form, monthly: 'last' }, LAST_FRI, true), 'FREQ=MONTHLY;BYDAY=-1FR')
  assert.equal(monthlyLabel('nth', TUE), 'On the second Tuesday')
  assert.equal(monthlyLabel('last', LAST_FRI), 'On the last Friday')
  assert.equal(monthlyLabel('day', TUE), 'On day 9')
})

test('eventRepeat: ends on a date or after a number of times', () => {
  const form = withFreq(emptyForm(TUE), 'daily', TUE)
  assert.equal(buildRepeat({ ...form, end: 'on', until: '2026-07-01' }, TUE, true), 'FREQ=DAILY;UNTIL=20260701')
  assert.equal(buildRepeat({ ...form, end: 'on', until: '2026-07-01' }, TUE, false), 'FREQ=DAILY;UNTIL=20260701T235959')
  assert.equal(buildRepeat({ ...form, end: 'after', count: 5 }, TUE, false), 'FREQ=DAILY;COUNT=5')
  assert.equal(validRepeat({ ...form, end: 'on', until: '2026-06-01' }, TUE), false, 'an end before the start')
  assert.equal(validRepeat({ ...form, end: 'after', count: 0 }, TUE), false)
  assert.equal(validRepeat({ ...form, interval: 1.5 }, TUE), false)
  assert.equal(validRepeat({ ...form, end: 'on', until: TUE }, TUE), true)
})

test('eventRepeat: the summary is one sentence', () => {
  const s = (rule: string, start = TUE) => repeatSummary(parseRepeat(rule, start), start)
  assert.equal(s('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20260601'), 'Every 2 weeks on Mon and Thu, until Jun 1')
  assert.equal(s('FREQ=DAILY'), 'Every day')
  assert.equal(s('FREQ=DAILY;INTERVAL=3;COUNT=1'), 'Every 3 days, 1 time')
  assert.equal(s('FREQ=MONTHLY;BYDAY=2TU;COUNT=6'), 'Every month on the second Tuesday, 6 times')
  assert.equal(s('FREQ=MONTHLY;INTERVAL=3;BYDAY=-1FR', LAST_FRI), 'Every 3 months on the last Friday')
  assert.equal(s('FREQ=MONTHLY;BYMONTHDAY=9;UNTIL=20270101'), 'Every month on day 9, until Jan 1, 2027')
  assert.equal(s('FREQ=YEARLY'), 'Every year on June 9')
  assert.equal(s(''), '')
})
