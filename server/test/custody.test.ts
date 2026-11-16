// Family Hub: the kids' schedule (routes/custody.ts): which days the kids are home, kept as one
// repeating pattern plus changes for single days, instead of all-day events on the calendar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { openDb, applyMigrations } from '../src/d1-sqlite.ts';
import type { Env } from '../src/env.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = 'ke_test_admin';

async function setup() {
  const db = openDb(':memory:');
  applyMigrations(db, path.join(__dirname, '..', 'migrations'));
  const env = { DB: db as unknown as D1Database, ADMIN_API_KEY: ADMIN, PUBLIC_URL: 'http://localhost', ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' } as Env;
  const app = createApp();
  const json = async (p: string, method = 'GET', body?: unknown, key = ADMIN) => {
    const headers = new Headers({ Authorization: `Bearer ${key}` });
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await app.request(p, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, env);
    return { status: res.status, body: (await res.json()) as any };
  };
  const display = (await json('/api/keys', 'POST', { name: 'Wall', scope: 'display' })).body.key as string;
  return { json, display };
}

const here = { kind: 'here', time: null };
const away = { kind: 'away', time: null };
const SCHEDULE = {
  label: 'Kids here',
  memberIds: [],
  start: '2026-11-16',
  days: [here, { kind: 'leave', time: '18:00' }, away, away, { kind: 'arrive', time: '18:00' }, here, here],
  changes: { '2026-12-24': here },
};

test('no schedule until a parent makes one', async () => {
  const { json, display } = await setup();
  assert.deepEqual((await json('/api/custody', 'GET', undefined, display)).body, { schedule: null });
});

test('a parent saves the schedule and the wall screen reads it', async () => {
  const { json, display } = await setup();
  const put = await json('/api/custody', 'PUT', { schedule: SCHEDULE });
  assert.equal(put.status, 200);
  assert.deepEqual((await json('/api/custody', 'GET', undefined, display)).body, { schedule: SCHEDULE });
  assert.equal((await json('/api/custody', 'PUT', { schedule: null }, display)).status, 403); // parents only
  assert.deepEqual((await json('/api/custody', 'PUT', { schedule: null })).body, { schedule: null });
  assert.deepEqual((await json('/api/custody')).body, { schedule: null });
});

test('a handover needs a time, and a plain day has none', async () => {
  const { json } = await setup();
  const bad = (days: unknown[]) => json('/api/custody', 'PUT', { schedule: { ...SCHEDULE, days } });
  assert.equal((await bad([{ kind: 'arrive', time: null }])).status, 400);
  assert.equal((await bad([{ kind: 'here', time: '18:00' }])).status, 400);
  assert.equal((await bad([{ kind: 'leave', time: '25:00' }])).status, 400);
  assert.equal((await bad([])).status, 400);
  assert.equal((await json('/api/custody', 'PUT', { schedule: { ...SCHEDULE, start: '16-11-2026' } })).status, 400);
});

test('only people in the family can be on the schedule', async () => {
  const { json } = await setup();
  assert.equal((await json('/api/custody', 'PUT', { schedule: { ...SCHEDULE, memberIds: ['nobody'] } })).status, 400);
});
