// node --test test/ (npm test). The kids' schedule: which state a date is in (custody.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { custodyOn, custodyText, patternFrom, type CustodySchedule } from '../src/custody.ts'
import { setHour12 } from '../src/timeFormat.ts'

const here = { kind: 'here', time: null } as const
const away = { kind: 'away', time: null } as const
const arrive = { kind: 'arrive', time: '18:00' } as const
const leave = { kind: 'leave', time: '18:00' } as const
// Short week (Sun evening to Tue evening), then long week (Fri evening to Tue evening), from Mon 16 Nov.
const s: CustodySchedule = {
  label: 'Kids here', memberIds: [], start: '2026-11-16',
  days: [here, leave, away, away, arrive, here, here, here, leave, away, away, away, away, arrive],
  changes: { '2026-12-02': here },
}

test('custodyOn: a date in the first round of the pattern', () => {
  assert.deepEqual(custodyOn(s, '2026-11-16'), here)
  assert.deepEqual(custodyOn(s, '2026-11-17'), leave)
  assert.deepEqual(custodyOn(s, '2026-11-20'), arrive)
  assert.deepEqual(custodyOn(s, '2026-11-29'), arrive)
})

test('custodyOn: the pattern repeats, across the clocks changing', () => {
  assert.deepEqual(custodyOn(s, '2026-11-30'), here) // day 14 = day 0
  assert.deepEqual(custodyOn(s, '2027-03-30'), custodyOn(s, '2026-11-17')) // 133 days on, after DST starts
})

test('custodyOn: dates before the start count back', () => {
  assert.deepEqual(custodyOn(s, '2026-11-15'), arrive)
  assert.deepEqual(custodyOn(s, '2026-11-02'), here)
})

test('custodyOn: a change for one date wins', () => {
  assert.deepEqual(custodyOn(s, '2026-12-02'), here)
  assert.deepEqual(custodyOn(s, '2026-12-03'), away)
})

test('custodyText: says when the kids come and go', () => {
  setHour12(false)
  assert.equal(custodyText(s, here), 'Kids here')
  assert.equal(custodyText(s, arrive), 'Kids here from 18:00')
  assert.equal(custodyText(s, leave), 'Kids here until 18:00')
  assert.equal(custodyText(s, away), null)
})

test('patternFrom: a weekly or two-weekly pattern from Monday', () => {
  assert.equal(patternFrom('2026-11-18', 1), '2026-11-16')
  assert.equal(patternFrom('2026-11-16', 1), '2026-11-16')
  assert.equal(patternFrom('2026-11-18', 0), '2026-11-15')
})
