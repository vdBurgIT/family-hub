import { test } from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import { buildVevent, deleteOccurrence, editCalendarObject, normalizeRrule, seriesRrule, splitInstanceKey, vtimezone } from '../src/providers/caldav-ical.ts';
import { expandICS } from '../src/providers/ics.ts';

const TZ = 'Europe/Amsterdam';
const ics = (...lines: string[]) => lines.join('\r\n');

// A weekly Monday 09:00 Amsterdam series, the way iCloud writes one: VTIMEZONE, alarm, attendee,
// URL and an X- property Kinwall knows nothing about, plus one moved occurrence.
const WEEKLY = ics(
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iCloud//EN',
  vtimezone(TZ, 2026),
  'BEGIN:VEVENT', 'UID:swim@x', 'DTSTAMP:20260101T000000Z', 'SEQUENCE:2',
  'DTSTART;TZID=Europe/Amsterdam:20260105T090000', 'DTEND;TZID=Europe/Amsterdam:20260105T100000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO', 'EXDATE;TZID=Europe/Amsterdam:20260112T090000',
  'SUMMARY:Swimming', 'LOCATION:Pool', 'URL:https://example.test/swim', 'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
  'ATTENDEE;CN=Sam:mailto:sam@example.test',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'DESCRIPTION:Reminder', 'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT', 'UID:swim@x', 'DTSTAMP:20260101T000000Z', 'RECURRENCE-ID;TZID=Europe/Amsterdam:20260119T090000',
  'DTSTART;TZID=Europe/Amsterdam:20260119T110000', 'DTEND;TZID=Europe/Amsterdam:20260119T120000', 'SUMMARY:Swimming (late)',
  'END:VEVENT',
  'END:VCALENDAR',
);

const FROM = new Date('2026-01-01T00:00:00Z');
const TO = new Date('2026-08-01T00:00:00Z');
const expand = (text: string) => expandICS(text, FROM, TO, TZ);
const vevents = (text: string) => new ICAL.Component(ICAL.parse(text) as unknown as unknown[]).getAllSubcomponents('vevent');
const master = (text: string) => vevents(text).find((c) => !c.getFirstProperty('recurrence-id'))!;

test('caldav-ical: an instance key splits into uid and occurrence', () => {
  assert.deepEqual(splitInstanceKey('swim@x::20260105T090000'), { uid: 'swim@x', recurrenceKey: '20260105T090000' });
  assert.deepEqual(splitInstanceKey('a::b::20260105T080000Z'), { uid: 'a::b', recurrenceKey: '20260105T080000Z' });
  assert.deepEqual(splitInstanceKey('a::20260105'), { uid: 'a', recurrenceKey: '20260105' });
  assert.deepEqual(splitInstanceKey('only-uid'), { uid: 'only-uid', recurrenceKey: '' });
});

test('caldav-ical: the fixture reads as expected', async () => {
  const evs = await expand(WEEKLY);
  assert.equal(evs.find((e) => e.start === '2026-01-12T08:00:00.000Z'), undefined, 'EXDATE skips the 12th');
  assert.equal(evs.find((e) => e.externalId === 'swim@x::20260119T090000')?.start, '2026-01-19T10:00:00.000Z');
  assert.equal(evs.find((e) => e.externalId === 'swim@x::20260601T090000')?.start, '2026-06-01T07:00:00.000Z', 'summer time keeps 09:00');
});

test('caldav-ical: editing one occurrence adds an override and leaves the series alone', async () => {
  const out = editCalendarObject(WEEKLY, 'swim@x::20260209T090000', { title: 'Swim gala', start: '2026-02-09T12:00:00.000Z', end: '2026-02-09T14:00:00.000Z', allDay: false }, 'occurrence', TZ);
  const m = master(out);
  assert.equal(m.getFirstPropertyValue('summary'), 'Swimming');
  assert.equal(String(m.getFirstPropertyValue('rrule')), 'FREQ=WEEKLY;BYDAY=MO');
  assert.equal(m.getAllSubcomponents('valarm').length, 1);
  assert.match(out, /ATTENDEE;CN=Sam:mailto:sam@example.test/);
  const evs = await expand(out);
  const gala = evs.find((e) => e.externalId === 'swim@x::20260209T090000')!;
  assert.equal(gala.title, 'Swim gala');
  assert.equal(gala.start, '2026-02-09T12:00:00.000Z');
  assert.deepEqual(gala.reminders, [15], 'the copy keeps the alarm');
  assert.match(out, /RECURRENCE-ID;TZID=Europe\/Amsterdam:20260209T090000/);
  assert.equal(evs.find((e) => e.externalId === 'swim@x::20260216T090000')?.title, 'Swimming');
  assert.equal(evs.length, (await expand(WEEKLY)).length, 'no occurrence gained or lost');
});

test('caldav-ical: editing an occurrence that already has an override changes that override', async () => {
  const out = editCalendarObject(WEEKLY, 'swim@x::20260119T090000', { title: 'Late swim', location: '' }, 'occurrence', TZ);
  assert.equal(vevents(out).length, 2);
  const late = (await expand(out)).find((e) => e.externalId === 'swim@x::20260119T090000')!;
  assert.equal(late.title, 'Late swim');
  assert.equal(late.start, '2026-01-19T10:00:00.000Z', 'its own time stays');
});

test('caldav-ical: editing the series moves every occurrence by the same clock time, keeping its TZID', async () => {
  // The occurrence on 1 June (summer time, 07:00Z) moves to 10:30 local.
  const out = editCalendarObject(WEEKLY, 'swim@x::20260601T090000', { title: 'Swim', start: '2026-06-01T08:30:00.000Z', end: '2026-06-01T09:30:00.000Z', allDay: false }, 'series', TZ);
  const m = master(out);
  assert.match(out, /DTSTART;TZID=Europe\/Amsterdam:20260105T103000/);
  assert.match(out, /DTEND;TZID=Europe\/Amsterdam:20260105T113000/);
  assert.match(out, /EXDATE;TZID=Europe\/Amsterdam:20260112T103000/, 'the skipped day moves along');
  assert.match(out, /RECURRENCE-ID;TZID=Europe\/Amsterdam:20260119T103000/, 'the changed one stays attached');
  assert.equal(m.getFirstPropertyValue('summary'), 'Swim');
  assert.equal(m.getFirstPropertyValue('sequence'), 3);
  assert.equal(m.getAllSubcomponents('valarm').length, 1);
  assert.match(out, /URL:https:\/\/example.test\/swim/);
  assert.match(out, /X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC/);
  const evs = await expand(out);
  assert.equal(evs.find((e) => e.externalId === 'swim@x::20260105T103000')?.start, '2026-01-05T09:30:00.000Z', 'winter: 10:30 CET');
  assert.equal(evs.find((e) => e.externalId === 'swim@x::20260601T103000')?.start, '2026-06-01T08:30:00.000Z', 'summer: 10:30 CEST');
  assert.equal(evs.find((e) => e.start.startsWith('2026-01-12')), undefined);
  const late = evs.find((e) => e.externalId === 'swim@x::20260119T103000')!;
  assert.equal(late.start, '2026-01-19T10:00:00.000Z', 'a moved occurrence keeps its own time');
  assert.equal(late.title, 'Swimming (late)', 'and its own title');
});

test('caldav-ical: a series title change reaches overrides that had the old title', () => {
  const plain = editCalendarObject(WEEKLY, 'swim@x::20260209T090000', { location: 'Lake' }, 'occurrence', TZ);
  const out = editCalendarObject(plain, 'swim@x::20260302T090000', { title: 'Swim club' }, 'series', TZ);
  const titles = vevents(out).map((c) => c.getFirstPropertyValue('summary'));
  assert.deepEqual(titles, ['Swim club', 'Swimming (late)', 'Swim club']);
});

test('caldav-ical: a series can get a new repeat, or stop repeating', async () => {
  const biweekly = editCalendarObject(WEEKLY, 'swim@x::20260105T090000', { rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20260301' }, 'series', TZ);
  assert.match(biweekly, /RRULE:FREQ=WEEKLY;BYDAY=MO,TH;INTERVAL=2;UNTIL=20260301T225959Z|RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20260301T225959Z/);
  assert.equal(seriesRrule(biweekly)?.includes('INTERVAL=2'), true);
  const once = editCalendarObject(WEEKLY, 'swim@x::20260105T090000', { rrule: null }, 'series', TZ);
  assert.equal(vevents(once).length, 1);
  assert.doesNotMatch(once.slice(once.indexOf('BEGIN:VEVENT')), /RRULE|EXDATE/);
  assert.equal((await expand(once)).length, 1);
});

test('caldav-ical: deleting one occurrence adds an EXDATE in the series zone and drops its override', async () => {
  const out = deleteOccurrence(WEEKLY, 'swim@x::20260119T090000', TZ)!;
  assert.match(out, /EXDATE;TZID=Europe\/Amsterdam:20260119T090000/);
  assert.equal(vevents(out).length, 1);
  const evs = await expand(out);
  assert.equal(evs.find((e) => e.externalId === 'swim@x::20260119T090000'), undefined);
  assert.equal(evs.length, (await expand(WEEKLY)).length - 1);
  assert.equal(master(out).getAllSubcomponents('valarm').length, 1);
});

test('caldav-ical: deleting from an all-day or UTC series uses the same value type as DTSTART', () => {
  const allDay = ics('BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:bin', 'DTSTART;VALUE=DATE:20260106', 'DTEND;VALUE=DATE:20260107', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Bins', 'END:VEVENT', 'END:VCALENDAR');
  assert.match(deleteOccurrence(allDay, 'bin::20260113', TZ)!, /EXDATE;VALUE=DATE:20260113/);
  const utc = ics('BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:u', 'DTSTART:20260106T170000Z', 'DTEND:20260106T180000Z', 'RRULE:FREQ=DAILY', 'SUMMARY:Run', 'END:VEVENT', 'END:VCALENDAR');
  assert.match(deleteOccurrence(utc, 'u::20260108T170000Z', TZ)!, /EXDATE:20260108T170000Z/);
});

test('caldav-ical: a single event is deleted whole and edited in place, keeping what Kinwall does not edit', async () => {
  const single = ics('BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:dentist', 'DTSTART;TZID=Europe/Amsterdam:20260310T140000', 'DTEND;TZID=Europe/Amsterdam:20260310T150000',
    'SUMMARY:Dentist', 'URL:https://example.test/d', 'X-CUSTOM:keep', 'ATTENDEE:mailto:alex@example.test', 'BEGIN:VALARM', 'ACTION:AUDIO', 'TRIGGER:-PT1H', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR');
  assert.equal(deleteOccurrence(single, 'dentist::20260310T140000', TZ), null);
  const out = editCalendarObject(single, 'dentist::20260310T140000', { title: 'Dentist (Maya)', start: '2026-03-10T14:00:00.000Z', end: '2026-03-10T15:00:00.000Z', allDay: false, busy: false }, 'occurrence', TZ);
  assert.match(out, /DTSTART;TZID=Europe\/Amsterdam:20260310T150000/);
  for (const keep of [/URL:https:\/\/example.test\/d/, /X-CUSTOM:keep/, /ATTENDEE:mailto:alex@example.test/, /BEGIN:VALARM/, /TRANSP:TRANSPARENT/]) assert.match(out, keep);
  const [ev] = await expand(out);
  assert.equal(ev.title, 'Dentist (Maya)');
  assert.equal(ev.busy, false);
});

test('caldav-ical: a single UTC event that starts repeating moves to household clock time', async () => {
  const single = ics('BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:p', 'DTSTART:20260302T160000Z', 'DTEND:20260302T170000Z', 'SUMMARY:Piano', 'END:VEVENT', 'END:VCALENDAR');
  const out = editCalendarObject(single, 'p::20260302T160000Z', { rrule: 'FREQ=WEEKLY;BYDAY=MO' }, 'series', TZ);
  assert.match(out, /DTSTART;TZID=Europe\/Amsterdam:20260302T170000/);
  assert.match(out, /BEGIN:VTIMEZONE/);
  assert.ok(out.indexOf('BEGIN:VTIMEZONE') < out.indexOf('BEGIN:VEVENT'));
  const evs = await expand(out);
  assert.equal(evs.find((e) => e.start.startsWith('2026-04-06'))?.start, '2026-04-06T15:00:00.000Z', 'still 17:00 after the clocks change');
});

test('caldav-ical: a new repeating timed event uses TZID wall time with a VTIMEZONE', async () => {
  const out = buildVevent('new@kinwall', { title: 'Football', start: '2026-03-04T15:00:00.000Z', end: '2026-03-04T16:30:00.000Z', allDay: false }, { rrule: 'FREQ=WEEKLY;BYDAY=WE;UNTIL=20260610', tz: TZ });
  assert.match(out, /DTSTART;TZID=Europe\/Amsterdam:20260304T160000/);
  assert.match(out, /RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20260610T215959Z/);
  const evs = await expand(out);
  assert.equal(evs.at(-1)?.start, '2026-06-10T14:00:00.000Z', 'the until day is included, at 16:00 summer time');
  assert.equal(evs[0].seriesId, 'new@kinwall');
  const allDay = buildVevent('d', { title: 'Bins', start: '2026-03-04', end: '2026-03-05', allDay: true }, { rrule: 'FREQ=MONTHLY;BYDAY=-1FR', tz: TZ });
  assert.match(allDay, /DTSTART;VALUE=DATE:20260304/);
  assert.doesNotMatch(allDay, /VTIMEZONE/);
  const plain = buildVevent('e', { title: 'Lunch', start: '2026-03-04T11:00:00.000Z', end: '2026-03-04T12:00:00.000Z', allDay: false }, { tz: TZ });
  assert.match(plain, /DTSTART:20260304T110000Z/);
});

test('caldav-ical: UNTIL takes the form DTSTART needs', () => {
  assert.equal(normalizeRrule('FREQ=DAILY;UNTIL=20260601', { kind: 'date' }, TZ), 'FREQ=DAILY;UNTIL=20260601');
  assert.equal(normalizeRrule('RRULE:FREQ=DAILY;UNTIL=20260601T235959', { kind: 'tzid', tzid: TZ }, TZ), 'FREQ=DAILY;UNTIL=20260601T215959Z');
  assert.equal(normalizeRrule('FREQ=DAILY;UNTIL=20260601T215959Z', { kind: 'date' }, TZ), 'FREQ=DAILY;UNTIL=20260601');
  assert.equal(normalizeRrule('FREQ=DAILY;UNTIL=20260601;COUNT=2', { kind: 'utc' }, 'UTC'), 'FREQ=DAILY;UNTIL=20260601T235959Z;COUNT=2');
  assert.equal(normalizeRrule('FREQ=DAILY;COUNT=3', { kind: 'utc' }, TZ), 'FREQ=DAILY;COUNT=3');
});

test('caldav-ical: the VTIMEZONE it writes matches Intl', () => {
  for (const zone of ['Europe/Amsterdam', 'America/New_York', 'Australia/Sydney', 'Asia/Tokyo']) {
    const comp = new ICAL.Component(ICAL.parse(vtimezone(zone, 2026)) as unknown as unknown[]);
    const tzc = new ICAL.Timezone(comp);
    for (const iso of ['2026-01-15T12:00:00Z', '2026-04-15T12:00:00Z', '2026-07-15T12:00:00Z', '2026-10-15T12:00:00Z', '2027-03-30T12:00:00Z']) {
      const at = new Date(iso);
      const local = ICAL.Time.fromJSDate(at, true).convertToZone(tzc);
      const want = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(at);
      assert.equal(String(local.hour).padStart(2, '0'), want, `${zone} ${iso}`);
    }
  }
});
