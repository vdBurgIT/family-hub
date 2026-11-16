// Family Hub: Home Assistant tiles on the board (routes/home.ts), against a fake Home Assistant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { openDb, applyMigrations } from '../src/d1-sqlite.ts';
import type { Env } from '../src/env.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADMIN = 'ke_test_admin';

function fakeHa() {
  const states: Record<string, { entity_id: string; state: string; attributes: Record<string, unknown> }> = {
    'light.kitchen': { entity_id: 'light.kitchen', state: 'off', attributes: { friendly_name: 'Kitchen' } },
    'lock.front': { entity_id: 'lock.front', state: 'locked', attributes: { friendly_name: 'Front door' } },
    'sensor.temp': { entity_id: 'sensor.temp', state: '20', attributes: {} },
  };
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin !== 'http://ha.test') return real(input, init);
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer ha-fake-token');
    const p = url.pathname;
    if (p === '/api/states') return Response.json(Object.values(states));
    if (p.startsWith('/api/states/')) return Response.json(states[p.slice(12)]);
    if (p.startsWith('/api/services/')) {
      calls.push(p.slice(14));
      const id = JSON.parse(String(init?.body)).entity_id;
      if (p.endsWith('/toggle')) states[id].state = states[id].state === 'on' ? 'off' : 'on';
      if (p.endsWith('lock/unlock')) states[id].state = 'unlocked';
      return Response.json([]);
    }
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

async function setup(withHa = true) {
  const db = openDb(':memory:');
  applyMigrations(db, path.join(__dirname, '..', 'migrations'));
  const env = { DB: db as unknown as D1Database, ADMIN_API_KEY: ADMIN, PUBLIC_URL: 'http://localhost', ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=', ...(withHa ? { HA_URL: 'http://ha.test', HA_TOKEN: 'ha-fake-token' } : {}) } as Env;
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

test('a wall screen sees and switches only the tiles a parent picked', async () => {
  const ha = fakeHa();
  try {
    const { json, display } = await setup();
    assert.deepEqual((await json('/api/home', 'GET', undefined, display)).body, { configured: true, tiles: [], error: null });
    const picked = (await json('/api/home/entities')).body.map((e: any) => e.entityId);
    assert.deepEqual(picked, ['light.kitchen', 'lock.front']); // no sensors
    assert.equal((await json('/api/home/tiles', 'PUT', { entityIds: ['light.kitchen'] })).status, 200);
    const home = (await json('/api/home', 'GET', undefined, display)).body;
    assert.equal(home.tiles[0].name, 'Kitchen');
    assert.equal(home.tiles[0].on, false);
    const on = await json('/api/home/light.kitchen/toggle', 'POST', undefined, display);
    assert.equal(on.status, 200);
    assert.equal(on.body.on, true);
    assert.equal((await json('/api/home/lock.front/toggle', 'POST', undefined, display)).status, 404); // not on the board
    assert.equal((await json('/api/home/tiles', 'PUT', { entityIds: [] }, display)).status, 403); // parents only
    assert.equal((await json('/api/home/entities', 'GET', undefined, display)).status, 403);
  } finally { ha.restore(); }
});

test('a lock on the board can be locked but never unlocked', async () => {
  const ha = fakeHa();
  try {
    const { json, display } = await setup();
    await json('/api/home/tiles', 'PUT', { entityIds: ['lock.front'] });
    const res = await json('/api/home/lock.front/toggle', 'POST', undefined, display);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, 'locked');
    assert.deepEqual(ha.calls, []);
  } finally { ha.restore(); }
});

test('without HA_URL the card says it is not set up', async () => {
  const { json } = await setup(false);
  assert.deepEqual((await json('/api/home')).body, { configured: false, tiles: [], error: null });
  assert.equal((await json('/api/home/tiles', 'PUT', { entityIds: ['sensor.temp'] })).status, 400);
});
