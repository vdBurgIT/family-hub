// Family Hub: the kids' schedule. Which days the kids are home, kept as one repeating pattern
// (day 0 is `start`, then `days` over and over) plus changes for single dates (holidays, swaps),
// so the calendar shows it as a strip on each day instead of all-day events. Settings key `custody`;
// the web app works out each day (web/src/custody.ts). Everyone reads it, parents change it.
import { createRoute, z } from '@hono/zod-openapi';
import { createRouter } from '../router.ts';
import type { KinwallDb } from '../db.ts';
import { emit } from '../bus.ts';
import { ErrorSchema } from '../schemas.ts';

export const custodyRoutes = createRouter();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const DaySchema = z
  .object({
    kind: z.enum(['here', 'away', 'arrive', 'leave']).openapi({ description: 'here: all day. away: not at all. arrive: from `time` on. leave: until `time`.' }),
    time: z.string().regex(TIME).nullable().openapi({ description: 'HH:MM of the handover; only for arrive and leave' }),
  })
  .refine((d) => (d.kind === 'arrive' || d.kind === 'leave') === (d.time !== null), { message: 'A handover day has a time, other days have none.' })
  .openapi('CustodyDay');

const ScheduleSchema = z
  .object({
    label: z.string().trim().min(1).max(40).openapi({ description: 'What the strip says, e.g. "Kids here"' }),
    memberIds: z.array(z.string()).max(12).openapi({ description: 'The kids it is about (their faces on the strip)' }),
    start: z.string().regex(DATE).openapi({ description: 'YYYY-MM-DD: the first day of the pattern' }),
    days: z.array(DaySchema).min(1).max(28).openapi({ description: 'The pattern, one entry per day from `start`, repeating' }),
    changes: z.record(z.string().regex(DATE), DaySchema).openapi({ description: 'Single dates that differ from the pattern' }),
  })
  .openapi('CustodySchedule');
type Schedule = z.infer<typeof ScheduleSchema>;

const BodySchema = z.object({ schedule: ScheduleSchema.nullable() });

export async function loadCustody(db: KinwallDb): Promise<Schedule | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = 'custody'").first<{ value: string }>();
  if (!row) return null;
  try {
    const parsed = ScheduleSchema.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

custodyRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/api/custody',
    tags: ['Custody'],
    summary: "The kids' schedule: which days they are home",
    security: [{ Bearer: [] }],
    responses: { 200: { description: 'ok', content: { 'application/json': { schema: BodySchema } } } },
  }),
  async (c) => c.json({ schedule: await loadCustody(c.env.DB) }, 200),
);

custodyRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/api/custody',
    tags: ['Custody'],
    summary: "Parents' devices: save the kids' schedule, or null to remove it",
    security: [{ Bearer: [] }],
    request: { body: { content: { 'application/json': { schema: BodySchema } } } },
    responses: {
      200: { description: 'ok', content: { 'application/json': { schema: BodySchema } } },
      400: { description: 'invalid', content: { 'application/json': { schema: ErrorSchema } } },
    },
  }),
  async (c) => {
    const { schedule } = c.req.valid('json');
    const db = c.env.DB;
    if (!schedule) {
      await db.prepare("DELETE FROM settings WHERE key = 'custody'").run();
      emit(c, 'settings.changed', { custody: false });
      return c.json({ schedule: null }, 200);
    }
    if (Object.keys(schedule.changes).length > 400) return c.json({ error: 'Too many single-day changes.' }, 400);
    const ids = [...new Set(schedule.memberIds)];
    if (ids.length) {
      const found = await db.prepare(`SELECT id FROM members WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{ id: string }>();
      if ((found.results ?? []).length !== ids.length) return c.json({ error: 'Someone on the schedule is not in the family.' }, 400);
    }
    const saved = { ...schedule, memberIds: ids };
    await db.prepare("INSERT INTO settings (key, value) VALUES ('custody', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(saved)).run();
    emit(c, 'settings.changed', { custody: true });
    return c.json({ schedule: saved }, 200);
  },
);
