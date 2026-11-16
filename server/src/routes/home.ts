// Family Hub: Home Assistant tiles on the board (lights, switches, scenes...). The server talks to
// Home Assistant with HA_URL + HA_TOKEN (env, never sent to a browser); screens see and switch only
// the entities a parent put on the board (settings key `homeTiles`). A lock can only be locked here.
import { createRoute, z } from '@hono/zod-openapi';
import { createRouter } from '../router.ts';
import type { Env } from '../env.ts';
import type { KinwallDb } from '../db.ts';
import { emit } from '../bus.ts';
import { ErrorSchema } from '../schemas.ts';

export const homeRoutes = createRouter();

const TIMEOUT_MS = 8000;
export const HOME_DOMAINS = ['light', 'switch', 'fan', 'input_boolean', 'scene', 'script', 'cover', 'lock'] as const;
type Domain = typeof HOME_DOMAINS[number];
const MAX_TILES = 24;

type HaState = { entity_id: string; state: string; attributes?: { friendly_name?: string; brightness?: number; icon?: string } };

const TileSchema = z
  .object({
    entityId: z.string(),
    name: z.string(),
    domain: z.enum(HOME_DOMAINS),
    state: z.string().openapi({ description: "Home Assistant's state: on/off, open/closed, locked/unlocked, unavailable..." }),
    on: z.boolean().openapi({ description: 'Shown as on: on, open or locked' }),
    brightness: z.number().nullable().openapi({ description: 'A light at 0-100 %, when Home Assistant gives it' }),
  })
  .openapi('HomeTile');
const HomeSchema = z
  .object({ configured: z.boolean().openapi({ description: 'HA_URL and HA_TOKEN are set on the server' }), tiles: z.array(TileSchema), error: z.string().nullable() })
  .openapi('Home');
const EntitySchema = z.object({ entityId: z.string(), name: z.string(), domain: z.enum(HOME_DOMAINS), state: z.string() }).openapi('HomeEntity');

const configured = (env: Env) => !!env.HA_URL && !!env.HA_TOKEN;
const domainOf = (id: string) => id.split('.')[0] as Domain;
const isHomeEntity = (id: string) => /^[a-z_]+\.[a-z0-9_]+$/.test(id) && (HOME_DOMAINS as readonly string[]).includes(domainOf(id));

async function ha<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${env.HA_URL!.replace(/\/+$/, '')}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${env.HA_TOKEN}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Home Assistant answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function homeTileIds(db: KinwallDb): Promise<string[]> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'homeTiles'").first<{ value: string }>();
  try {
    const ids = JSON.parse(row?.value ?? '[]');
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string' && isHomeEntity(x)) : [];
  } catch {
    return [];
  }
}

function tileFrom(s: HaState) {
  const domain = domainOf(s.entity_id);
  const b = s.attributes?.brightness;
  return {
    entityId: s.entity_id,
    name: s.attributes?.friendly_name || s.entity_id,
    domain,
    state: s.state,
    on: s.state === 'on' || s.state === 'open' || s.state === 'locked',
    brightness: domain === 'light' && s.state === 'on' && typeof b === 'number' ? Math.round((b / 255) * 100) : null,
  };
}

homeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/api/home',
    tags: ['Home'],
    summary: 'The Home Assistant tiles on the board, with their state now',
    security: [{ Bearer: [] }],
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: HomeSchema } } } },
  }),
  async (c) => {
    if (!configured(c.env)) return c.json({ configured: false, tiles: [], error: null }, 200);
    const ids = await homeTileIds(c.env.DB);
    if (!ids.length) return c.json({ configured: true, tiles: [], error: null }, 200);
    try {
      const states = await ha<HaState[]>(c.env, '/api/states');
      const byId = new Map(states.map((s) => [s.entity_id, s]));
      const tiles = ids.map((id) => byId.get(id) ?? { entity_id: id, state: 'unavailable' }).map(tileFrom);
      return c.json({ configured: true, tiles, error: null }, 200);
    } catch (err) {
      console.error('home assistant read failed', err instanceof Error ? err.message : err);
      return c.json({ configured: true, tiles: [], error: "Home Assistant can't be reached right now." }, 200);
    }
  },
);

homeRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/api/home/{entityId}/toggle',
    tags: ['Home'],
    summary: 'Switch a tile: lights, switches and fans toggle, scenes and scripts run, covers open or close, locks only lock',
    security: [{ Bearer: [] }],
    request: { params: z.object({ entityId: z.string() }) },
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: TileSchema } } },
      400: { description: 'not set up', content: { 'application/json': { schema: ErrorSchema } } },
      404: { description: 'not on the board', content: { 'application/json': { schema: ErrorSchema } } },
      502: { description: 'Home Assistant failed', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { entityId } = c.req.valid('param');
    if (!configured(c.env)) return c.json({ error: 'Home Assistant is not set up on the server.' }, 400);
    if (!(await homeTileIds(c.env.DB)).includes(entityId)) return c.json({ error: 'not found' }, 404);
    const domain = domainOf(entityId);
    try {
      const now = await ha<HaState>(c.env, `/api/states/${entityId}`);
      const service =
        domain === 'scene' || domain === 'script' ? `${domain}/turn_on`
        : domain === 'lock' ? 'lock/lock'
        : domain === 'cover' ? `cover/${now.state === 'open' || now.state === 'opening' ? 'close_cover' : 'open_cover'}`
        : `${domain}/toggle`;
      if (domain === 'lock' && now.state === 'locked') return c.json(tileFrom(now), 200);
      await ha(c.env, `/api/services/${service}`, { method: 'POST', body: JSON.stringify({ entity_id: entityId }) });
      const after = await ha<HaState>(c.env, `/api/states/${entityId}`);
      emit(c, 'settings.changed', { home: entityId });
      return c.json(tileFrom(after), 200);
    } catch (err) {
      console.error('home assistant switch failed', err instanceof Error ? err.message : err);
      return c.json({ error: "That didn't switch. Home Assistant can't be reached right now." }, 502);
    }
  },
);

homeRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/api/home/entities',
    tags: ['Home'],
    summary: "Parents' devices: everything in Home Assistant that can go on the board",
    security: [{ Bearer: [] }],
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: z.array(EntitySchema) } } },
      400: { description: 'not set up', content: { 'application/json': { schema: ErrorSchema } } },
      502: { description: 'Home Assistant failed', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    if (!configured(c.env)) return c.json({ error: 'Home Assistant is not set up on the server.' }, 400);
    try {
      const states = await ha<HaState[]>(c.env, '/api/states');
      const list = states
        .filter((s) => isHomeEntity(s.entity_id))
        .map((s) => ({ entityId: s.entity_id, name: s.attributes?.friendly_name || s.entity_id, domain: domainOf(s.entity_id), state: s.state }))
        .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
      return c.json(list, 200);
    } catch (err) {
      console.error('home assistant read failed', err instanceof Error ? err.message : err);
      return c.json({ error: "Home Assistant can't be reached right now." }, 502);
    }
  },
);

homeRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/api/home/tiles',
    tags: ['Home'],
    summary: "Parents' devices: which Home Assistant entities are on the board, in order",
    security: [{ Bearer: [] }],
    request: { body: { content: { 'application/json': { schema: z.object({ entityIds: z.array(z.string()).max(MAX_TILES) }) } } } },
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: z.object({ entityIds: z.array(z.string()) }) } } },
      400: { description: 'invalid', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const ids = [...new Set(c.req.valid('json').entityIds)];
    const bad = ids.find((id) => !isHomeEntity(id));
    if (bad) return c.json({ error: `${bad} can't go on the board` }, 400);
    await c.env.DB.prepare("INSERT INTO settings (key, value) VALUES ('homeTiles', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(ids)).run();
    emit(c, 'settings.changed', { homeTiles: ids.length });
    return c.json({ entityIds: ids }, 200);
  },
);
