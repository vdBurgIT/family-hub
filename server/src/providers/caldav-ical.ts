// Read-modify-write of one CalDAV calendar object (iCloud, Fastmail, Nextcloud). A repeating event
// is one object: the series (the "master" VEVENT, with RRULE/EXDATE) plus one VEVENT per changed
// occurrence (RECURRENCE-ID). Kinwall edits only what it was asked to and keeps everything else as
// it came: alarms, attendees, URL, time zones, X- properties.
//
// Pure (no network): caldav.ts fetches the object, runs it through here and puts it back.
//
// Times: Kinwall's own values are UTC instants ('2026-09-24T14:00:00.000Z') or dates ('2026-09-24').
// A value written to the object keeps the form of the one it replaces: a date stays a date, a
// TZID time stays wall-clock time in that zone (so a weekly 09:00 keeps 09:00 across DST), a UTC
// time stays UTC. "Wall" below is wall-clock time in a zone as epoch ms (Date.UTC of its fields).
import ICAL from 'ical.js';
import { zonedParts, zonedTimeToUtc, type DateParts } from '../recurrence.ts';
import type { EventInput, WriteScope } from './types.ts';

export type { WriteScope };
/** What to change; undefined leaves a field as it is. rrule: a string sets the repeat, null ends it. */
export type CaldavPatch = Partial<EventInput> & { rrule?: string | null };

type Zone = { kind: 'date' } | { kind: 'utc' } | { kind: 'tzid'; tzid: string } | { kind: 'floating' };
type Moment = { wall: number; zone: Zone };

const DAY = 86_400_000;
const DATE: Zone = { kind: 'date' };
const UTC: Zone = { kind: 'utc' };
const FLOATING: Zone = { kind: 'floating' };

// The occurrence part of an instance key (ics.ts: `${uid}::${recurrenceId.toICALString()}`).
const RECURRENCE_KEY = /^\d{8}(T\d{6}Z?)?$/;

/** `<uid>::<occurrence>` (what ics.ts's expandICS gives each instance) into its two halves. A key
 * with no occurrence part (an event made before keys carried one) has recurrenceKey ''. */
export function splitInstanceKey(instanceKey: string): { uid: string; recurrenceKey: string } {
  const i = instanceKey.lastIndexOf('::');
  if (i !== -1 && RECURRENCE_KEY.test(instanceKey.slice(i + 2))) return { uid: instanceKey.slice(0, i), recurrenceKey: instanceKey.slice(i + 2) };
  return { uid: instanceKey, recurrenceKey: '' };
}

// --- time helpers ---------------------------------------------------------------------------

function ianaZone(tzid: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tzid }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const partsToWall = (p: DateParts) => Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s);
function wallToParts(wall: number): DateParts {
  const d = new Date(wall);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
const floorDay = (wall: number) => Math.floor(wall / DAY) * DAY;

/** The household zone as a Zone: a TZID, or UTC when the household runs on UTC. */
function householdZone(tz: string): Zone {
  const name = ianaZone(tz);
  return !name || name === 'UTC' || name === 'Etc/UTC' ? UTC : { kind: 'tzid', tzid: tz };
}

// A TZID Intl doesn't know (Outlook's "W. Europe Standard Time") is read through the object's own
// VTIMEZONE when there is one, else as household time.
function registered(tzid: string): ICAL.Timezone | null {
  return ICAL.TimezoneService.has(tzid) ? ICAL.TimezoneService.get(tzid) : null;
}

function toWall(instant: number, zone: Zone, tz: string): number {
  if (zone.kind === 'utc') return instant;
  if (zone.kind === 'tzid') {
    const name = ianaZone(zone.tzid);
    const reg = name ? null : registered(zone.tzid);
    if (reg) {
      const t = ICAL.Time.fromJSDate(new Date(instant), true).convertToZone(reg);
      return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
    }
    return partsToWall(zonedParts(new Date(instant), name ?? tz));
  }
  const wall = partsToWall(zonedParts(new Date(instant), tz));
  return zone.kind === 'date' ? floorDay(wall) : wall;
}

function toInstant(wall: number, zone: Zone, tz: string): number {
  if (zone.kind === 'utc') return wall;
  if (zone.kind === 'tzid') {
    const name = ianaZone(zone.tzid);
    const reg = name ? null : registered(zone.tzid);
    if (reg) {
      const p = wallToParts(wall);
      return ICAL.Time.fromData({ year: p.y, month: p.mo + 1, day: p.d, hour: p.h, minute: p.mi, second: p.s, isDate: false }, reg).toUnixTime() * 1000;
    }
    return zonedTimeToUtc(wallToParts(wall), name ?? tz).getTime();
  }
  return zonedTimeToUtc(wallToParts(wall), tz).getTime(); // floating, or a date's midnight: household time
}

const sameZone = (a: Zone, b: Zone) => a.kind === b.kind && (a.kind !== 'tzid' || a.tzid === (b as { tzid: string }).tzid);

/** `m` as wall time in `to`. A date read as a time is its midnight; a time read as a date is its
 * (household) day. */
function express(m: Moment, to: Zone, tz: string): number {
  if (sameZone(m.zone, to)) return m.wall;
  if (m.zone.kind === 'date') return m.wall;
  if (to.kind === 'date') return floorDay(toWall(toInstant(m.wall, m.zone, tz), FLOATING, tz));
  return toWall(toInstant(m.wall, m.zone, tz), to, tz);
}

function sameMoment(a: Moment, b: Moment, tz: string): boolean {
  if (a.zone.kind === 'date' || b.zone.kind === 'date') return express(a, DATE, tz) === express(b, DATE, tz);
  return toInstant(a.wall, a.zone, tz) === toInstant(b.wall, b.zone, tz);
}

const timeWall = (t: ICAL.Time) => Date.UTC(t.year, t.month - 1, t.day, t.isDate ? 0 : t.hour, t.isDate ? 0 : t.minute, t.isDate ? 0 : t.second);

function zoneOf(prop: ICAL.Property): Zone {
  const t = prop.getFirstValue() as ICAL.Time;
  if (t.isDate) return DATE;
  if (t.zone?.tzid === 'UTC') return UTC;
  const tzid = prop.getParameter('tzid');
  if (typeof tzid === 'string' && tzid) return { kind: 'tzid', tzid };
  return FLOATING;
}

const momentOf = (prop: ICAL.Property): Moment => ({ wall: timeWall(prop.getFirstValue() as ICAL.Time), zone: zoneOf(prop) });

/** A Kinwall value (stored format) as a moment. */
function inputMoment(value: string, allDay: boolean): Moment {
  return allDay ? { wall: Date.parse(`${value.slice(0, 10)}T00:00:00Z`), zone: DATE } : { wall: Date.parse(value), zone: UTC };
}

function timeValue(wall: number, zone: Zone): ICAL.Time {
  const p = wallToParts(wall);
  if (zone.kind === 'date') return ICAL.Time.fromData({ year: p.y, month: p.mo + 1, day: p.d, isDate: true });
  return ICAL.Time.fromData({ year: p.y, month: p.mo + 1, day: p.d, hour: p.h, minute: p.mi, second: p.s, isDate: false }, zone.kind === 'utc' ? ICAL.Timezone.utcTimezone : undefined);
}

function writeTimes(prop: ICAL.Property, walls: number[], zone: Zone): void {
  prop.resetType(zone.kind === 'date' ? 'date' : 'date-time');
  if (zone.kind === 'tzid') prop.setParameter('tzid', zone.tzid);
  else prop.removeParameter('tzid');
  if (prop.isMultiValue) prop.setValues(walls.map((w) => timeValue(w, zone)));
  else prop.setValue(timeValue(walls[0], zone));
}

function setTime(comp: ICAL.Component, name: string, wall: number, zone: Zone): void {
  let prop = comp.getFirstProperty(name);
  if (!prop) {
    prop = new ICAL.Property(name, comp);
    comp.addProperty(prop);
  }
  writeTimes(prop, [wall], zone);
}

/** A component's start and end (DTEND, else DTSTART + DURATION, else RFC 5545's defaults). */
function startEnd(comp: ICAL.Component): { start: Moment; end: Moment } {
  const start = momentOf(comp.getFirstProperty('dtstart')!);
  const endProp = comp.getFirstProperty('dtend');
  if (endProp) return { start, end: momentOf(endProp) };
  const duration = comp.getFirstPropertyValue('duration') as ICAL.Duration | null;
  const ms = duration ? duration.toSeconds() * 1000 : start.zone.kind === 'date' ? DAY : 0;
  return { start, end: { wall: start.wall + ms, zone: start.zone } };
}

function setStartEnd(comp: ICAL.Component, startWall: number, endWall: number, zone: Zone): void {
  setTime(comp, 'dtstart', startWall, zone);
  setTime(comp, 'dtend', endWall, zone);
  comp.removeAllProperties('duration');
}

// --- time zones -------------------------------------------------------------------------------

const offsetText = (min: number) => `${min < 0 ? '-' : '+'}${String(Math.floor(Math.abs(min) / 60)).padStart(2, '0')}${String(Math.abs(min) % 60).padStart(2, '0')}`;
const RR_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** The day of month of the nth (or, with -1, last) `weekday` of a month. */
function nthWeekday(year: number, month: number, weekday: number, n: number): number {
  if (n === -1) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7);
  }
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** A VTIMEZONE for an IANA zone, built from what Intl says about `year`: its two yearly changes as
 * rules (last Sunday of March ...), or one fixed offset. iCloud wants the zone of a TZID spelled
 * out in the object. ponytail: a zone whose changes don't follow an nth-weekday rule (a few that
 * follow Ramadan) is approximated by that year's dates. */
export function vtimezone(tz: string, year: number): string {
  const offsetAt = (ms: number) => (partsToWall(zonedParts(new Date(ms), tz)) - Math.floor(ms / 1000) * 1000) / 60000;
  const from = Date.UTC(year, 0, 1);
  const to = Date.UTC(year + 1, 0, 1);
  const changes: { at: number; fromOff: number; toOff: number }[] = [];
  let prevT = from;
  let prevOff = offsetAt(from);
  for (let t = from + DAY; t <= to; t += DAY) {
    const off = offsetAt(t);
    if (off !== prevOff) {
      let lo = prevT / 60000;
      let hi = t / 60000;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (offsetAt(mid * 60000) === prevOff) lo = mid;
        else hi = mid;
      }
      changes.push({ at: hi * 60000, fromOff: prevOff, toOff: off });
    }
    prevT = t;
    prevOff = off;
  }
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  if (changes.length !== 2) {
    const off = offsetAt(to - 1);
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${offsetText(off)}`, `TZOFFSETTO:${offsetText(off)}`, 'DTSTART:19700101T000000', 'END:STANDARD');
  } else {
    for (const [i, c] of changes.entries()) {
      const other = changes[1 - i];
      const local = new Date(c.at + c.fromOff * 60000); // the change as clock time before it
      const month = local.getUTCMonth();
      const day = local.getUTCDate();
      const weekday = local.getUTCDay();
      const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), month + 1, 0)).getUTCDate();
      const n = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7);
      const kind = c.toOff > other.toOff ? 'DAYLIGHT' : 'STANDARD';
      const onset = `1970${String(month + 1).padStart(2, '0')}${String(nthWeekday(1970, month, weekday, n)).padStart(2, '0')}T${String(local.getUTCHours()).padStart(2, '0')}${String(local.getUTCMinutes()).padStart(2, '0')}00`;
      lines.push(`BEGIN:${kind}`, `TZOFFSETFROM:${offsetText(c.fromOff)}`, `TZOFFSETTO:${offsetText(c.toOff)}`, `DTSTART:${onset}`, `RRULE:FREQ=YEARLY;BYMONTH=${month + 1};BYDAY=${n}${RR_DAYS[weekday]}`, `END:${kind}`);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines.join('\r\n');
}

/** Adds the VTIMEZONE for `zone` (the household's) when the object has none for it, first in line. */
function ensureVtimezone(root: ICAL.Component, zone: Zone, wall: number): void {
  if (zone.kind !== 'tzid') return;
  if (root.getAllSubcomponents('vtimezone').some((c) => c.getFirstPropertyValue('tzid') === zone.tzid)) return;
  const vtz = new ICAL.Component(ICAL.parse(vtimezone(zone.tzid, new Date(wall).getUTCFullYear())) as unknown as unknown[]);
  const rest = [...root.getAllSubcomponents()];
  for (const c of rest) root.removeSubcomponent(c);
  root.addSubcomponent(vtz);
  for (const c of rest) root.addSubcomponent(c);
}

// --- repeat rules -----------------------------------------------------------------------------

const fmtDate = (wall: number) => new Date(wall).toISOString().slice(0, 10).replace(/-/g, '');
const fmtDateTime = (wall: number) => new Date(wall).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '');

/** A repeat rule in the form RFC 5545 wants for a start in `zone`: UNTIL is a date for an all-day
 * event, UTC for a zoned one, floating for a floating one. Kinwall's editor sends UNTIL as a date
 * (or that date's 23:59:59), meaning "through that day" in the event's own time. */
export function normalizeRrule(rule: string, zone: Zone, tz: string): string {
  const r = rule.replace(/^RRULE:/i, '').trim();
  const m = /(^|;)UNTIL=([0-9TZ]+)/i.exec(r);
  if (!m) return r;
  const v = m[2].toUpperCase();
  const d = Date.UTC(Number(v.slice(0, 4)), Number(v.slice(4, 6)) - 1, Number(v.slice(6, 8)));
  const own: Zone = zone.kind === 'tzid' ? zone : FLOATING;
  let until: Moment;
  if (v.length === 8) {
    if (zone.kind === 'date') return r;
    until = { wall: d + DAY - 1000, zone: own };
  } else {
    const wall = d + (Number(v.slice(9, 11)) * 3600 + Number(v.slice(11, 13)) * 60 + Number(v.slice(13, 15))) * 1000;
    until = { wall, zone: v.endsWith('Z') ? UTC : own };
  }
  const value = zone.kind === 'date' ? fmtDate(express(until, DATE, tz))
    : zone.kind === 'floating' ? fmtDateTime(express(until, FLOATING, tz))
    : `${fmtDateTime(express(until, UTC, tz))}Z`;
  return r.slice(0, m.index + m[1].length) + ['UNTIL', value].join('=') + r.slice(m.index + m[0].length);
}

function setRrule(comp: ICAL.Component, rule: string, tz: string): void {
  const normalized = normalizeRrule(rule, zoneOf(comp.getFirstProperty('dtstart')!), tz);
  comp.updatePropertyWithValue('rrule', ICAL.Recur.fromString(normalized));
}

function endRepeat(comp: ICAL.Component): void {
  for (const name of ['rrule', 'rdate', 'exdate', 'exrule']) comp.removeAllProperties(name);
}

// --- fields -----------------------------------------------------------------------------------

const TEXT_FIELDS = [
  ['title', 'summary'],
  ['location', 'location'],
  ['description', 'description'],
  ['busy', 'transp'],
] as const;

function fieldValue(patch: CaldavPatch, key: (typeof TEXT_FIELDS)[number][0]): string | undefined {
  const v = patch[key];
  if (v === undefined) return undefined;
  if (key === 'busy') return v ? 'OPAQUE' : 'TRANSPARENT';
  return String(v ?? '');
}

const textOf = (comp: ICAL.Component, prop: string) => {
  const v = comp.getFirstPropertyValue(prop);
  return v == null ? null : String(v);
};

function setText(comp: ICAL.Component, prop: string, value: string): void {
  if (value === '') comp.removeAllProperties(prop);
  else if (textOf(comp, prop) !== value) comp.updatePropertyWithValue(prop, value);
}

/** Sets the patch's text fields on `comp`; `alike` get the same change where they held what `comp` did. */
function applyFields(comp: ICAL.Component, patch: CaldavPatch, alike: ICAL.Component[] = []): void {
  for (const [key, prop] of TEXT_FIELDS) {
    const value = fieldValue(patch, key);
    if (value === undefined) continue;
    const before = textOf(comp, prop);
    setText(comp, prop, value);
    for (const other of alike) if (textOf(other, prop) === before) setText(other, prop, value);
  }
}

function touch(comp: ICAL.Component, now: Date): void {
  const stamp = ICAL.Time.fromJSDate(new Date(Math.floor(now.getTime() / 1000) * 1000), true);
  comp.updatePropertyWithValue('dtstamp', stamp);
  if (comp.getFirstProperty('last-modified')) comp.updatePropertyWithValue('last-modified', stamp);
  const seq = comp.getFirstPropertyValue('sequence');
  if (seq != null && Number.isFinite(Number(seq))) comp.updatePropertyWithValue('sequence', Number(seq) + 1);
}

// --- the object -------------------------------------------------------------------------------

function parseRoot(ics: string): ICAL.Component {
  const root = new ICAL.Component(ICAL.parse(ics) as unknown as unknown[]);
  // TZIDs Intl doesn't know resolve through the object's own VTIMEZONEs (see registered()).
  for (const vtz of root.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(vtz);
      if (zone.tzid && !ianaZone(zone.tzid)) ICAL.TimezoneService.register(zone);
    } catch {
      // a malformed VTIMEZONE: its TZID reads as household time
    }
  }
  return root;
}

function eventsOf(root: ICAL.Component, uid: string): { master?: ICAL.Component; overrides: ICAL.Component[] } {
  const all = root.getAllSubcomponents('vevent');
  const mine = all.filter((c) => c.getFirstPropertyValue('uid') === uid);
  const list = mine.length ? mine : all; // one event per object; a changed UID still finds it
  return { master: list.find((c) => !c.getFirstProperty('recurrence-id')), overrides: list.filter((c) => !!c.getFirstProperty('recurrence-id')) };
}

const isRecurring = (comp: ICAL.Component) => !!(comp.getFirstProperty('rrule') || comp.getFirstProperty('rdate'));

/** The occurrence a key names, as a moment in the series' own start zone. */
function keyMoment(key: string, zone: Zone, tz: string): Moment {
  const d = Date.UTC(Number(key.slice(0, 4)), Number(key.slice(4, 6)) - 1, Number(key.slice(6, 8)));
  if (key.length === 8) return { wall: express({ wall: d, zone: DATE }, zone, tz), zone };
  const wall = d + (Number(key.slice(9, 11)) * 3600 + Number(key.slice(11, 13)) * 60 + Number(key.slice(13, 15))) * 1000;
  const own: Zone = key.endsWith('Z') ? UTC : zone.kind === 'date' ? FLOATING : zone;
  return { wall: express({ wall, zone: own }, zone, tz), zone };
}

function findOverride(overrides: ICAL.Component[], rec: Moment, tz: string): ICAL.Component | undefined {
  return overrides.find((o) => sameMoment(momentOf(o.getFirstProperty('recurrence-id')!), rec, tz));
}

/** The zone a component's times are written in: a date for all-day; otherwise the one it has, or,
 * for a timed event that had none (it was all-day) or that starts to repeat while in UTC, the
 * household's, so a repeat keeps its clock time across DST. */
function targetZone(current: Zone, allDay: boolean, repeating: boolean, tz: string): Zone {
  if (allDay) return DATE;
  if (current.kind !== 'date' && !(repeating && current.kind === 'utc')) return current;
  return repeating ? householdZone(tz) : UTC;
}

/** One VEVENT on its own: a single event, or one occurrence's override. */
function editComponent(root: ICAL.Component, comp: ICAL.Component, patch: CaldavPatch, tz: string, rrule: string | null | undefined): void {
  applyFields(comp, patch);
  const repeating = typeof rrule === 'string';
  if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined || repeating) {
    const cur = startEnd(comp);
    const allDay = patch.allDay ?? cur.start.zone.kind === 'date';
    const start = patch.start !== undefined ? inputMoment(patch.start, allDay) : cur.start;
    const end = patch.end !== undefined ? inputMoment(patch.end, allDay) : cur.end;
    const zone = targetZone(cur.start.zone, allDay, repeating, tz);
    if (!sameZone(zone, cur.start.zone) || !sameMoment(start, cur.start, tz) || !sameMoment(end, cur.end, tz)) {
      const startWall = express(start, zone, tz);
      ensureVtimezone(root, zone, startWall);
      setStartEnd(comp, startWall, express(end, zone, tz), zone);
    }
  }
  if (typeof rrule === 'string') setRrule(comp, rrule, tz);
  else if (rrule === null) endRepeat(comp);
}

function editOccurrence(root: ICAL.Component, master: ICAL.Component, overrides: ICAL.Component[], rec: Moment, patch: CaldavPatch, tz: string): ICAL.Component {
  let override = findOverride(overrides, rec, tz);
  if (!override) {
    // A copy of the series (alarms, attendees and all) pinned to this one occurrence.
    override = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
    for (const name of ['rrule', 'rdate', 'exdate', 'exrule', 'recurrence-id', 'sequence']) override.removeAllProperties(name);
    const series = startEnd(master);
    const length = express(series.end, series.start.zone, tz) - series.start.wall;
    setTime(override, 'recurrence-id', rec.wall, rec.zone);
    setStartEnd(override, rec.wall, rec.wall + length, rec.zone);
    const seq = master.getFirstPropertyValue('sequence');
    if (seq != null) override.updatePropertyWithValue('sequence', Number(seq));
    root.addSubcomponent(override);
  }
  editComponent(root, override, patch, tz, undefined);
  return override;
}

function editSeries(root: ICAL.Component, master: ICAL.Component, overrides: ICAL.Component[], rec: Moment, patch: CaldavPatch, tz: string, now: Date): void {
  const series = startEnd(master);
  const seriesLength = express(series.end, series.start.zone, tz) - series.start.wall;
  const own = findOverride(overrides, rec, tz);
  const occurrence = own ? startEnd(own) : { start: rec, end: { wall: rec.wall + seriesLength, zone: rec.zone } };

  if (patch.start !== undefined || patch.end !== undefined || patch.allDay !== undefined) {
    const allDay = patch.allDay ?? occurrence.start.zone.kind === 'date';
    const zone = allDay ? DATE : series.start.zone.kind === 'date' ? householdZone(tz) : series.start.zone;
    const newStart = patch.start !== undefined ? inputMoment(patch.start, allDay) : occurrence.start;
    const newEnd = patch.end !== undefined ? inputMoment(patch.end, allDay) : occurrence.end;
    // How far this occurrence moved, in the series' own clock time: the whole series moves as far.
    const shift = express(newStart, zone, tz) - express(occurrence.start, zone, tz);
    const length = express(newEnd, zone, tz) - express(newStart, zone, tz);
    const oldLength = express(occurrence.end, zone, tz) - express(occurrence.start, zone, tz);
    const zoneChanged = !sameZone(zone, series.start.zone);
    if (shift !== 0 || length !== oldLength || zoneChanged) {
      const startWall = express(series.start, zone, tz) + shift;
      ensureVtimezone(root, zone, startWall);
      setStartEnd(master, startWall, startWall + length, zone);
      // Skipped and changed occurrences are named by their old times: they move along.
      for (const prop of master.getAllProperties('exdate')) {
        const from = zoneOf(prop);
        writeTimes(prop, (prop.getValues() as ICAL.Time[]).map((t) => express({ wall: timeWall(t), zone: from }, zone, tz) + shift), zone);
      }
      for (const o of overrides) {
        const ridProp = o.getFirstProperty('recurrence-id')!;
        const rid = momentOf(ridProp);
        const times = startEnd(o);
        const unmoved = sameMoment(times.start, rid, tz);
        writeTimes(ridProp, [express(rid, zone, tz) + shift], zone);
        if (unmoved) {
          const s = express(times.start, zone, tz) + shift;
          setStartEnd(o, s, s + length, zone);
        }
        touch(o, now);
      }
      if (zoneChanged && patch.rrule === undefined) {
        const rule = master.getFirstPropertyValue('rrule') as ICAL.Recur | null;
        if (rule) setRrule(master, rule.toString(), tz);
      }
    }
  }

  applyFields(master, patch, overrides);
  for (const o of overrides) if (TEXT_FIELDS.some(([key]) => patch[key] !== undefined)) touch(o, now);
  if (patch.rrule === null) {
    endRepeat(master);
    for (const o of overrides) root.removeSubcomponent(o);
  } else if (typeof patch.rrule === 'string') setRrule(master, patch.rrule, tz);
}

/** The object with one occurrence (scope 'occurrence') or the whole series changed. A single event
 * is changed in place whatever the scope. `tz`: the household's, for floating times. */
export function editCalendarObject(ics: string, instanceKey: string, patch: CaldavPatch, scope: WriteScope, tz: string, now = new Date()): string {
  const root = parseRoot(ics);
  const { uid, recurrenceKey } = splitInstanceKey(instanceKey);
  const { master, overrides } = eventsOf(root, uid);
  if (master && isRecurring(master)) {
    const seriesStart = momentOf(master.getFirstProperty('dtstart')!);
    const rec = recurrenceKey ? keyMoment(recurrenceKey, seriesStart.zone, tz) : seriesStart;
    if (scope === 'series') editSeries(root, master, overrides, rec, patch, tz, now);
    else touch(editOccurrence(root, master, overrides, rec, patch, tz), now);
    if (scope === 'series') touch(master, now);
    return root.toString();
  }
  const target = master ?? (recurrenceKey ? overrides.find((o) => sameMoment(momentOf(o.getFirstProperty('recurrence-id')!), keyMoment(recurrenceKey, zoneOf(o.getFirstProperty('recurrence-id')!), tz), tz)) : undefined) ?? overrides[0];
  if (!target) throw new Error('the event is not in its calendar object');
  editComponent(root, target, patch, tz, master ? patch.rrule : undefined);
  touch(target, now);
  return root.toString();
}

/** The object without one occurrence: an EXDATE on the series (and its override gone). null when
 * nothing would be left, so the whole object goes. */
export function deleteOccurrence(ics: string, instanceKey: string, tz: string, now = new Date()): string | null {
  const root = parseRoot(ics);
  const { uid, recurrenceKey } = splitInstanceKey(instanceKey);
  const { master, overrides } = eventsOf(root, uid);
  if (master && isRecurring(master)) {
    const startProp = master.getFirstProperty('dtstart')!;
    const zone = zoneOf(startProp);
    const rec = recurrenceKey ? keyMoment(recurrenceKey, zone, tz) : momentOf(startProp);
    const exdate = new ICAL.Property('exdate', master);
    writeTimes(exdate, [rec.wall], zone);
    master.addProperty(exdate);
    for (const o of overrides) if (sameMoment(momentOf(o.getFirstProperty('recurrence-id')!), rec, tz)) root.removeSubcomponent(o);
    touch(master, now);
    return root.toString();
  }
  if (!master && recurrenceKey && overrides.length > 1) {
    const gone = overrides.filter((o) => {
      const prop = o.getFirstProperty('recurrence-id')!;
      return sameMoment(momentOf(prop), keyMoment(recurrenceKey, zoneOf(prop), tz), tz);
    });
    if (gone.length && gone.length < overrides.length) {
      for (const o of gone) root.removeSubcomponent(o);
      return root.toString();
    }
  }
  return null;
}

/** The repeat rule of the series an object holds, or null. */
export function seriesRrule(ics: string): string | null {
  try {
    const root = new ICAL.Component(ICAL.parse(ics) as unknown as unknown[]);
    const master = root.getAllSubcomponents('vevent').find((c) => !c.getFirstProperty('recurrence-id'));
    const rule = master?.getFirstPropertyValue('rrule') as ICAL.Recur | null | undefined;
    return rule ? rule.toString() : null;
  } catch {
    return null;
  }
}

function escapeText(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/,/g, '\\,').replace(/;/g, '\\;').replace(/\n/g, '\\n');
}

/** A new calendar object. A repeating timed event starts at household clock time with a TZID (and
 * its VTIMEZONE), so it keeps that time across DST; everything else is UTC or a date. */
export function buildVevent(uid: string, ev: EventInput, opts: { rrule?: string | null; tz?: string; now?: Date } = {}): string {
  const tz = opts.tz ?? 'UTC';
  const rrule = opts.rrule || null;
  const zone: Zone = ev.allDay ? DATE : rrule ? householdZone(tz) : UTC;
  const dt = (v: string) => {
    if (zone.kind === 'date') return `;VALUE=DATE:${v.slice(0, 10).replace(/-/g, '')}`;
    if (zone.kind === 'utc') return `:${fmtDateTime(Date.parse(v))}Z`;
    return `;TZID=${(zone as { tzid: string }).tzid}:${fmtDateTime(express(inputMoment(v, false), zone, tz))}`;
  };
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kinwall//EN'];
  if (zone.kind === 'tzid') lines.push(vtimezone(zone.tzid, new Date(Date.parse(ev.start)).getUTCFullYear()));
  lines.push(
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${fmtDateTime((opts.now ?? new Date()).getTime())}Z`,
    'DTSTART' + dt(ev.start),
    'DTEND' + dt(ev.end),
  );
  if (rrule) lines.push(`RRULE:${normalizeRrule(rrule, zone, tz)}`);
  lines.push(`SUMMARY:${escapeText(ev.title)}`, `TRANSP:${ev.busy === false ? 'TRANSPARENT' : 'OPAQUE'}`);
  if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}
