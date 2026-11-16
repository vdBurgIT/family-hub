// Repeating events on a CalDAV calendar through the API: which occurrence or series a write reaches,
// the series rule on each occurrence, and no double expansion. The CalDAV server is an in-memory
// object store behind the provider's methods (tsdav itself isn't exercised here); the objects are
// changed with the same caldav-ical.ts the real provider uses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { openDb, applyMigrations } from '../src/d1-sqlite.ts';
import type { Env } from '../src/env.ts';
import { encryptConfig } from '../src/crypto.ts';
import { caldavProvider } from '../src/providers/index.ts';
import { expandICS } from '../src/providers/ics.ts';
import { buildVevent, deleteOccurrence, editCalendarObject, splitInstanceKey } from '../src/providers/caldav-ical.ts';
import type { Provider } from '../src/providers/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_KEY = 'fc_test_admin_key';
const TZ = 'Europe/Amsterdam';
const DAY = 86400_000;

function makeEnv(): Env {
  const db = openDb(':memory:');
  applyMigrations(db, path.join(__dirname, '..', 'migrations'));
  return { DB: db as unknown as D1Database, ADMIN_API_KEY: ADMIN_KEY, PUBLIC_URL: 'http://localhost:8080', ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
}
function makeApp(env: Env) {
  const app = createApp();
  return (p: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${ADMIN_KEY}`);
    if (init.body) headers.set('Content-Type', 'application/json');
    return app.request(p, { ...init, headers }, env);
  };
}

// Next week's Monday, as a YYYYMMDD date in Amsterdam (09:00 there is well inside the sync window).
function nextMonday(): string {
  const d = new Date(Date.now() + 7 * DAY);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

type Call = { method: string; externalId?: string; opts?: unknown };

/** caldavProvider's methods over an in-memory store; restore() puts the real ones back. */
function fakeServer(objects: Map<string, string>) {
  const calls: Call[] = [];
  const real = { ...caldavProvider };
  const list = async (from: Date, to: Date) => {
    const out = [];
    for (const [href, ics] of objects) for (const ev of await expandICS(ics, from, to, TZ)) out.push({ ...ev, externalId: `${href}::${ev.externalId}` });
    return out;
  };
  const at = (href: string, ics: string, start: string) => expandICS(ics, new Date(Date.parse(start) - 2 * DAY), new Date(Date.parse(start) + 2 * DAY), TZ)
    .then((evs) => evs.map((ev) => ({ ...ev, externalId: `${href}::${ev.externalId}` })).find((ev) => ev.start === start));
  const fake: Provider = {
    listCalendars: async () => [{ remoteId: 'https://caldav.example.test/cal/', name: 'Family', writable: true }],
    listEvents: async (_ctx, from, to) => list(from, to),
    async createEvent(_ctx, ev, opts) {
      calls.push({ method: 'create', opts });
      const uid = `new-${objects.size}`;
      const href = `/cal/${uid}.ics`;
      const ics = buildVevent(uid, ev, { rrule: opts?.rrule, tz: TZ });
      objects.set(href, ics);
      return (await at(href, ics, ev.start))!;
    },
    async updateEvent(_ctx, externalId, ev, opts) {
      calls.push({ method: 'update', externalId, opts });
      const href = externalId.slice(0, externalId.indexOf('::'));
      const ics = editCalendarObject(objects.get(href)!, externalId.slice(href.length + 2), { ...ev, ...(opts?.rrule !== undefined ? { rrule: opts.rrule } : {}) }, opts?.scope ?? 'occurrence', TZ);
      objects.set(href, ics);
      return (await at(href, ics, ev.start!))!;
    },
    async deleteEvent(_ctx, externalId, opts) {
      calls.push({ method: 'delete', externalId, opts });
      const href = externalId.slice(0, externalId.indexOf('::'));
      const left = opts?.scope === 'series' ? null : deleteOccurrence(objects.get(href)!, externalId.slice(href.length + 2), TZ);
      if (left === null) objects.delete(href);
      else objects.set(href, left);
    },
  };
  Object.assign(caldavProvider, fake);
  return { calls, restore: () => Object.assign(caldavProvider, real) };
}

async function setup() {
  const env = makeEnv();
  await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('timezone', ?)").bind(TZ).run();
  const config = await encryptConfig(env, 'c1', {});
  await env.DB.prepare("INSERT INTO calendars (id, kind, remote_id, name, config, writable, enabled) VALUES ('c1', 'caldav', 'https://caldav.example.test/cal/', 'Family', ?, 1, 1)").bind(config).run();
  const monday = nextMonday();
  const objects = new Map([[
    '/cal/swim.ics',
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:swim', 'DTSTAMP:20260101T000000Z', `DTSTART;TZID=${TZ}:${monday}T090000`, `DTEND;TZID=${TZ}:${monday}T100000`,
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6', 'SUMMARY:Swimming', 'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT15M', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
  ]]);
  const server = fakeServer(objects);
  const request = makeApp(env);
  const window = `from=${new Date(Date.now() - DAY).toISOString()}&to=${new Date(Date.now() + 120 * DAY).toISOString()}`;
  const events = async () => ((await (await request(`/api/events?${window}&calendarId=c1`)).json()) as any[]).sort((a, b) => a.start.localeCompare(b.start));
  assert.equal((await request('/api/calendars/c1/sync', { method: 'POST' })).status, 200);
  return { env, request, events, objects, server, monday };
}

test('caldav repeats: each occurrence carries its series rule and is listed once', async () => {
  const { events, server } = await setup();
  try {
    const evs = await events();
    assert.equal(evs.length, 6);
    for (const ev of evs) {
      assert.equal(ev.seriesRrule, 'FREQ=WEEKLY;COUNT=6;BYDAY=MO'); // as ical.js writes it
      assert.equal(ev.rrule, null, 'a synced row is never expanded again');
      assert.equal(ev.seriesId, 'swim');
    }
  } finally {
    server.restore();
  }
});

test('caldav repeats: an edit without a scope changes just that occurrence', async () => {
  const { request, events, objects, server } = await setup();
  try {
    const evs = await events();
    const res = await request(`/api/events/${evs[2].id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Swim gala' }) });
    assert.equal(res.status, 200);
    assert.deepEqual(server.calls.at(-1)?.opts, { scope: 'occurrence' });
    assert.equal(splitInstanceKey(server.calls.at(-1)!.externalId!.split('::').slice(1).join('::')).uid, 'swim');
    const after = await events();
    assert.deepEqual(after.map((e) => e.title), ['Swimming', 'Swimming', 'Swim gala', 'Swimming', 'Swimming', 'Swimming']);
    assert.match(objects.get('/cal/swim.ics')!, /RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=6/, 'the series is still there');
  } finally {
    server.restore();
  }
});

test('caldav repeats: a series edit moves every occurrence and the calendar is read back', async () => {
  const { request, events, objects, server } = await setup();
  try {
    const evs = await events();
    const third = evs[2];
    const start = new Date(Date.parse(third.start) + 90 * 60_000).toISOString();
    const end = new Date(Date.parse(third.end) + 90 * 60_000).toISOString();
    const res = await request(`/api/events/${third.id}`, { method: 'PATCH', body: JSON.stringify({ start, end, allDay: false, title: 'Swim', scope: 'series' }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.start, start);
    assert.equal(body.title, 'Swim');
    const after = await events();
    assert.equal(after.length, 6);
    after.forEach((ev, i) => {
      assert.equal(ev.title, 'Swim');
      assert.equal(ev.start, new Date(Date.parse(evs[i].start) + 90 * 60_000).toISOString());
    });
    assert.match(objects.get('/cal/swim.ics')!, /BEGIN:VALARM/);
  } finally {
    server.restore();
  }
});

test('caldav repeats: a new repeat goes to the series only when asked for the series', async () => {
  const { request, events, server } = await setup();
  try {
    const evs = await events();
    await request(`/api/events/${evs[0].id}`, { method: 'PATCH', body: JSON.stringify({ rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3', title: 'Swimming' }) });
    assert.deepEqual(server.calls.at(-1)?.opts, { scope: 'occurrence' }, 'one occurrence has no repeat of its own');
    await request(`/api/events/${evs[0].id}`, { method: 'PATCH', body: JSON.stringify({ rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3', scope: 'series' }) });
    assert.deepEqual(server.calls.at(-1)?.opts, { scope: 'series', rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3' });
    const after = await events();
    assert.equal(after.length, 3);
    assert.equal(after[0].seriesRrule, 'FREQ=WEEKLY;COUNT=3;BYDAY=MO');
  } finally {
    server.restore();
  }
});

test('caldav repeats: deleting one occurrence keeps the rest; deleting the series removes them all', async () => {
  const { request, events, server } = await setup();
  try {
    const evs = await events();
    assert.equal((await request(`/api/events/${evs[1].id}`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(server.calls.at(-1)?.opts, { scope: 'occurrence' });
    assert.equal((await events()).length, 5);
    assert.equal((await request('/api/calendars/c1/sync', { method: 'POST' })).status, 200);
    assert.equal((await events()).length, 5, 'still gone after a sync');
    assert.equal((await request(`/api/events/${evs[3].id}?scope=series`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(server.calls.at(-1)?.opts, { scope: 'series' });
    assert.equal((await events()).length, 0);
  } finally {
    server.restore();
  }
});

test('caldav repeats: a new repeating event is written with its rule and all its occurrences show', async () => {
  const { request, events, server, monday } = await setup();
  try {
    const day = `${monday.slice(0, 4)}-${monday.slice(4, 6)}-${monday.slice(6)}`;
    const res = await request('/api/events', { method: 'POST', body: JSON.stringify({ calendarId: 'c1', title: 'Piano', start: `${day}T15:00:00.000Z`, end: `${day}T16:00:00.000Z`, allDay: false, rrule: 'FREQ=DAILY;COUNT=3' }) });
    assert.equal(res.status, 201);
    assert.deepEqual(server.calls.at(-1)?.opts, { rrule: 'FREQ=DAILY;COUNT=3' });
    const piano = (await events()).filter((e) => e.title === 'Piano');
    assert.equal(piano.length, 3);
    assert.equal(piano[0].seriesRrule, 'FREQ=DAILY;COUNT=3');
    assert.equal(piano[0].id, ((await res.json()) as any).id, 'the created row is the one sync keeps');
  } finally {
    server.restore();
  }
});
