// node --test test/ (npm test). A timed event's start and end on the calendar and board (eventSpan.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { eventSpan } from '../src/eventSpan.ts'
import { setHour12 } from '../src/timeFormat.ts'

const tz = 'Europe/Amsterdam'

test('eventSpan: an event on one day shows start and end', () => {
  setHour12(false)
  assert.equal(eventSpan({ start: '2027-03-10T14:00:00Z', end: '2027-03-10T15:30:00Z' }, '2027-03-10', tz), '15:00 – 16:30')
})

test('eventSpan: an event without length shows its start only', () => {
  setHour12(false)
  assert.equal(eventSpan({ start: '2027-03-10T14:00:00Z', end: '2027-03-10T14:00:00Z' }, '2027-03-10', tz), '15:00')
})

test('eventSpan: a stay over several days names the other day on each side', () => {
  setHour12(false)
  const stay = { start: '2027-03-12T16:00:00Z', end: '2027-03-15T08:00:00Z' } // Fri 17:00 to Mon 09:00
  assert.match(eventSpan(stay, '2027-03-12', tz), /^17:00 – \S+ 09:00$/)
  assert.match(eventSpan(stay, '2027-03-13', tz), /^\S+ 17:00 – \S+ 09:00$/)
  assert.match(eventSpan(stay, '2027-03-15', tz), /^\S+ 17:00 – 09:00$/)
})

test('eventSpan: follows the 12-hour clock', () => {
  setHour12(true)
  assert.equal(eventSpan({ start: '2027-03-10T14:00:00Z', end: '2027-03-10T15:30:00Z' }, '2027-03-10', tz), '3:00 PM – 4:30 PM')
  setHour12(false)
})
