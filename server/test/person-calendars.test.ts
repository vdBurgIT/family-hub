// Family Hub (PERSON_CALENDARS=1): who an event is for decides which calendars hold it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { openDb, applyMigrations } from '../src/d1-sqlite.ts';
import type { Env } from '../src/env.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = 'ke_test_admin';

async function setup(on = true) {
  const db = openDb(':memory:');
  applyMigrations(db, path.join(__dirname, '..', 'migrations'));
  const env = { DB: db as unknown as D1Database, ADMIN_API_KEY: ADMIN, PUBLIC_URL: 'http://localhost', ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', ...(on ? { PERSON_CALENDARS: '1' } : {}) } as Env;
  const app = createApp();
  const json = async (p: string, method = 'GET', body?: unknown) => {
    const headers = new Headers({ Authorization: `Bearer ${ADMIN}` });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await app.request(p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env);
    return { status: res.status, body: (await res.json()) as any };
  };
  const member = async (name: string) => (await json('/api/members', 'POST', { name, color: '#123456' })).body.id as string;
  const alex = await member('Alex'), sam = await member('Sam'), maya = await member('Maya'); // Maya has no calendar
  const calendar = async (name: string, memberIds: string[]) => (await json('/api/calendars', 'POST', { kind: 'local', name, memberIds })).body.id as string;
  const alexCal = await calendar('Alex', [alex]);
  const samCal = await calendar('Sam', [sam]);
  const family = await calendar('Family', []);
  const where = async (title: string) => {
    const evs = (await json('/api/events?from=2027-03-01&to=2027-03-31')).body as any[];
    return evs.filter((e) => e.title === title).map((e) => e.calendarId).sort();
  };
  return { json, alex, sam, maya, alexCal, samCal, family, where };
}

const ev = { title: 'Swimming', start: '2027-03-10T14:00:00Z', end: '2027-03-10T15:00:00Z', allDay: false };

test('a new event for two people lands in both their calendars', async () => {
  const { json, alex, sam, alexCal, samCal, family, where } = await setup();
  const res = await json('/api/events', 'POST', { ...ev, calendarId: family, memberIds: [alex, sam] });
  assert.equal(res.status, 201);
  assert.deepEqual(await where('Swimming'), [alexCal, samCal].sort());
});

test('giving an event to someone else moves it to their calendar', async () => {
  const { json, alex, sam, alexCal, samCal, where } = await setup();
  const made = (await json('/api/events', 'POST', { ...ev, calendarId: alexCal })).body;
  const moved = await json(`/api/events/${made.id}`, 'PATCH', { memberIds: [sam] });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.calendarId, samCal);
  assert.deepEqual(moved.body.memberIds, [sam]);
  assert.deepEqual(await where('Swimming'), [samCal]);
});

test('changing the time or title changes every copy, and delete removes them all', async () => {
  const { json, alex, sam, family, where } = await setup();
  const made = (await json('/api/events', 'POST', { ...ev, calendarId: family, memberIds: [alex, sam] })).body;
  const res = await json(`/api/events/${made.id}`, 'PATCH', { title: 'Swim class', start: '2027-03-10T15:00:00Z', end: '2027-03-10T16:30:00Z' });
  assert.equal(res.status, 200);
  const evs = (await json('/api/events?from=2027-03-01&to=2027-03-31')).body as any[];
  assert.equal(evs.filter((e) => e.title === 'Swim class' && e.end === '2027-03-10T16:30:00Z').length, 2);
  assert.equal((await json(`/api/events/${made.id}`, 'DELETE')).status, 200);
  assert.deepEqual(await where('Swim class'), []);
});

test('someone without a calendar of their own is tagged on a copy', async () => {
  const { json, alex, maya, alexCal, family, where } = await setup();
  const made = (await json('/api/events', 'POST', { ...ev, calendarId: family, memberIds: [alex, maya] })).body;
  assert.deepEqual(await where('Swimming'), [alexCal]);
  assert.deepEqual([...made.memberIds].sort(), [alex, maya].sort());
});

test('taking someone off removes only their copy', async () => {
  const { json, alex, sam, alexCal, family, where } = await setup();
  const made = (await json('/api/events', 'POST', { ...ev, calendarId: family, memberIds: [alex, sam] })).body;
  const res = await json(`/api/events/${made.id}`, 'PATCH', { memberIds: [alex] });
  assert.equal(res.status, 200);
  assert.deepEqual(await where('Swimming'), [alexCal]);
  assert.deepEqual(res.body.memberIds, [alex]);
});

test('without PERSON_CALENDARS people are only a tag, as in Kinwall', async () => {
  const { json, alex, sam, family, where } = await setup(false);
  const made = (await json('/api/events', 'POST', { ...ev, calendarId: family, memberIds: [alex, sam] })).body;
  assert.deepEqual(await where('Swimming'), [family]);
  assert.deepEqual([...made.memberIds].sort(), [alex, sam].sort());
});
