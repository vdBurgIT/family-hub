// Family Hub: who an event is for decides which calendars hold it (PERSON_CALENDARS=1).
//
// A "person calendar" is a writable, enabled calendar whose "Who is this for?" is exactly one
// member (an iCloud calendar per child, say). Giving an event to people puts a copy in each of
// their person calendars and takes it out of the ones of people no longer on it, so the phones
// see the same thing as the wall. The wall shows the copies as one event (web dedupeEvents:
// same title and times on different calendars), with everyone's faces.
//
// Copies are found the way the wall merges them: the same title, start, end and all-day flag on
// another calendar. A repeating event is left as it is (a person tag only), and so is an event on
// a calendar Family Hub can't write to.
import type { Context } from 'hono';
import type { Env } from './env.ts';
import type { KinwallDb } from './db.ts';
import { parseMemberIds } from './calendar-members.ts';
import { createEvent, deleteEvent, loadEventAndCalendar, setMemberOverride, type CalendarRow, type EventRow } from './routes/events.ts';

type Ctx = Context<{ Bindings: Env }>;
type Fail = { error: string; status: 400 | 403 | 404 | 502 };

export const personCalendarsOn = (env: Env) => env.PERSON_CALENDARS === '1';

const norm = (title: string) => title.trim().replace(/\s+/g, ' ').toLowerCase();
const repeats = (row: EventRow) => !!row.rrule || !!row.series_id;

/** member id -> their person calendar (a synced one before a Kinwall one, then the first added). */
export async function personCalendars(db: KinwallDb): Promise<Map<string, CalendarRow>> {
  const { results } = await db.prepare("SELECT * FROM calendars WHERE writable = 1 AND enabled = 1 AND kind != 'ics' ORDER BY CASE WHEN kind = 'local' THEN 1 ELSE 0 END, rowid").all<CalendarRow>();
  const out = new Map<string, CalendarRow>();
  for (const cal of results) {
    const ids = parseMemberIds(cal.member_ids);
    if (ids.length === 1 && !out.has(ids[0])) out.set(ids[0], cal);
  }
  return out;
}

/** The event and its copies on other calendars (same title, start, end, all-day), each once. */
export async function copiesOf(db: KinwallDb, row: EventRow): Promise<EventRow[]> {
  if (repeats(row)) return [row];
  const { results } = await db
    .prepare('SELECT * FROM events WHERE start = ? AND end = ? AND all_day = ? AND calendar_id != ? AND rrule IS NULL AND series_id IS NULL')
    .bind(row.start, row.end, row.all_day, row.calendar_id)
    .all<EventRow>();
  const seen = new Set([row.calendar_id]);
  const out = [row];
  for (const r of results) {
    if (norm(r.title) !== norm(row.title) || seen.has(r.calendar_id)) continue;
    seen.add(r.calendar_id);
    out.push(r);
  }
  return out;
}

/** Point what hangs off an event (its notes, a meal, an outing) at the copy that stays. */
async function relink(db: KinwallDb, from: string, to: string) {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("UPDATE notes SET target_id = ? WHERE target_type = 'event' AND target_id = ?").bind(to, from),
    db.prepare('UPDATE meals SET calendar_event_id = ?, updated_at = ? WHERE calendar_event_id = ?').bind(to, now, from),
    db.prepare('UPDATE outings SET calendar_event_id = ?, updated_at = ? WHERE calendar_event_id = ?').bind(to, now, from),
  ]);
}

/** Set an event's own people on one copy: [] goes back to its calendar's. */
async function setPeople(db: KinwallDb, row: EventRow, cal: CalendarRow, memberIds: string[]) {
  if (cal.kind === 'local') {
    await db.prepare('UPDATE events SET member_ids = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify(memberIds), new Date().toISOString(), row.id).run();
  } else if (row.external_id) {
    await setMemberOverride(db, cal.id, row.external_id, memberIds);
  }
}

/**
 * Put event `id` in the person calendars of `memberIds` and out of the others. Returns the id of
 * the copy that answers for it (the event itself when it stays), `null` when this event isn't
 * handled this way (setting off, a repeat, a read-only calendar, or nobody here has a person
 * calendar) so the caller tags it as before, or a failure.
 */
export async function placeForPeople(c: Ctx, id: string, memberIds: string[]): Promise<{ id: string } | Fail | null> {
  if (!personCalendarsOn(c.env)) return null;
  const found = await loadEventAndCalendar(c.env.DB, id);
  if (!found) return { error: 'not found', status: 404 };
  const { row, cal } = found;
  if (repeats(row) || !cal.writable || cal.kind === 'ics') return null;

  const byMember = await personCalendars(c.env.DB);
  const targets = new Map<string, CalendarRow>(); // calendar id -> calendar
  for (const m of memberIds) {
    const pc = byMember.get(m);
    if (pc) targets.set(pc.id, pc);
  }
  if (!targets.size) return null;
  const without = memberIds.filter((m) => !byMember.has(m)); // people with no calendar of their own

  const copies = await copiesOf(c.env.DB, row);
  const onCal = new Map(copies.map((r) => [r.calendar_id, r]));
  const kept: { row: EventRow; cal: CalendarRow }[] = [];

  // Add first, take away after: a failed write leaves one copy too many, never none.
  for (const target of targets.values()) {
    const have = onCal.get(target.id);
    if (have) { kept.push({ row: have, cal: target }); continue; }
    const made = await createEvent(c, {
      calendarId: target.id,
      title: row.title,
      start: row.start,
      end: row.end,
      allDay: !!row.all_day,
      location: row.location ?? undefined,
      description: row.description ?? undefined,
      busy: row.busy === undefined ? undefined : !!row.busy,
      categoryId: row.category_id ?? undefined,
    });
    if ('error' in made) return made;
    kept.push({ row: made.row, cal: made.cal });
  }

  const answer = kept.find((k) => k.row.id === id)?.row.id ?? kept[0].row.id;
  for (const copy of copies) {
    if (targets.has(copy.calendar_id)) continue;
    const other = copy.id === id ? found : await loadEventAndCalendar(c.env.DB, copy.id);
    if (!other || !other.cal.writable || other.cal.kind === 'ics') continue; // can't take it out of a feed
    await relink(c.env.DB, copy.id, answer);
    const gone = await deleteEvent(c, copy.id);
    if ('error' in gone) return gone;
  }

  // Each copy is for its calendar's person; anyone without a calendar of their own rides on one.
  for (const [i, k] of kept.entries()) {
    const own = parseMemberIds(k.cal.member_ids);
    await setPeople(c.env.DB, k.row, k.cal, i === 0 && without.length ? [...own, ...without] : []);
  }
  return { id: answer };
}
