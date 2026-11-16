// CalDAV provider (iCloud, Fastmail, Nextcloud, ...) via tsdav + Basic auth (app-specific
// password for iCloud). Recurrence expansion reuses ics.ts's parser so it isn't duplicated.
import { DAVClient } from 'tsdav';
import { expandICS } from './ics.ts';
import { buildVevent, deleteOccurrence, editCalendarObject } from './caldav-ical.ts';
import { assertSafeFeedUrl, feedFetch, type FeedEnv } from '../outbound.ts';
import type {
  EventInput,
  NormalizedEvent,
  Provider,
  ProviderCtx,
  RemoteCalendar,
  WriteOptions,
  WriteScope,
} from './types.ts';

type CaldavConfig = { serverUrl: string; username: string; password: string };

// externalId is "<href>::<uid>::<occurrence>" (the object's URL, then ics.ts's instance key), so
// each occurrence of a repeat has its own id while writes still find their object. Writes are
// read-modify-write of that object (caldav-ical.ts): one occurrence or the whole series.
function splitExternalId(externalId: string): { href: string; instanceKey: string } {
  const i = externalId.indexOf('::');
  return i === -1 ? { href: externalId, instanceKey: '' } : { href: externalId.slice(0, i), instanceKey: externalId.slice(i + 2) };
}

// SSRF guard (outbound.ts) on the server URL and, when given, the calendar collection URL -
// remoteId is client-supplied on POST /api/calendars, and tsdav fetches it as-is. Every request
// tsdav makes (incl. discovered/redirected URLs) goes through feedFetch, which re-checks per hop.
function client(env: FeedEnv, config: CaldavConfig, calendarUrl?: string | null): DAVClient {
  assertSafeFeedUrl(env, config.serverUrl);
  if (calendarUrl) assertSafeFeedUrl(env, calendarUrl);
  return new DAVClient({
    serverUrl: config.serverUrl,
    credentials: { username: config.username, password: config.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
    fetch: (input, init) => feedFetch(env, input, init),
  });
}

function humanError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/401|403/.test(msg)) return new Error('CalDAV login rejected — check username/password');
  return new Error(`CalDAV error: ${msg}`);
}

export async function verifyAccount(
  env: FeedEnv,
  serverUrl: string,
  username: string,
  password: string,
): Promise<{ name: string; config: CaldavConfig }> {
  const c = client(env, { serverUrl, username, password });
  try {
    await c.login();
  } catch (err) {
    throw humanError(err);
  }
  return { name: username, config: { serverUrl, username, password } };
}

export { buildVevent };

/** The instance of `ics` an edit or create gave back: the one with this key, else the one starting
 * at `start`, else the first near it. */
async function instanceIn(ics: string, href: string, instanceKey: string, start: string, tz: string): Promise<NormalizedEvent | undefined> {
  const at = Date.parse(start.length === 10 ? `${start}T00:00:00Z` : start);
  const near = await expandICS(ics, new Date(at - 2 * 86400_000), new Date(at + 2 * 86400_000), tz);
  const found = near.find((ev) => ev.externalId === instanceKey) ?? near.find((ev) => ev.start === start) ?? near[0];
  return found && { ...found, externalId: `${href}::${found.externalId}` };
}

async function fetchObject(c: DAVClient, ctx: ProviderCtx, href: string): Promise<{ data: string; etag?: string }> {
  const [existing] = await c.fetchCalendarObjects({ calendar: { url: ctx.calendar.remoteId ?? '' }, objectUrls: [href] });
  if (!existing?.data) throw new Error('the event is no longer in the calendar');
  return { data: existing.data, etag: existing.etag };
}

export const provider: Provider = {
  async listCalendars(ctx): Promise<RemoteCalendar[]> {
    const config = ctx.account?.config as CaldavConfig | undefined;
    if (!config) throw new Error('CalDAV account is not connected');
    const c = client(ctx.env, config);
    try {
      await c.login();
      const calendars = await c.fetchCalendars();
      return calendars
        .filter((cal) => !cal.components || cal.components.includes('VEVENT'))
        .map((cal) => ({
          remoteId: cal.url,
          name: typeof cal.displayName === 'string' ? cal.displayName : cal.url,
          color: cal.calendarColor,
          // tsdav doesn't surface the DAV privilege set, so assume writable unless the
          // collection explicitly excludes VEVENT.
          writable: true,
        }));
    } catch (err) {
      throw humanError(err);
    }
  },

  async listEvents(ctx: ProviderCtx, from: Date, to: Date): Promise<NormalizedEvent[]> {
    const config = ctx.account?.config as CaldavConfig | undefined;
    if (!config) throw new Error('CalDAV account is not connected');
    const c = client(ctx.env, config, ctx.calendar.remoteId);
    try {
      await c.login();
      const objects = await c.fetchCalendarObjects({
        calendar: { url: ctx.calendar.remoteId ?? '' },
        timeRange: { start: from.toISOString(), end: to.toISOString() },
      });
      const events: NormalizedEvent[] = [];
      for (const obj of objects) {
        if (!obj.data) continue;
        for (const instance of await expandICS(obj.data, from, to, ctx.env.TIMEZONE ?? 'UTC')) {
          events.push({ ...instance, externalId: `${obj.url}::${instance.externalId}` });
        }
      }
      return events;
    } catch (err) {
      throw humanError(err);
    }
  },

  async createEvent(ctx: ProviderCtx, ev: EventInput, opts?: { rrule?: string | null }): Promise<NormalizedEvent> {
    const config = ctx.account?.config as CaldavConfig | undefined;
    if (!config) throw new Error('CalDAV account is not connected');
    const c = client(ctx.env, config, ctx.calendar.remoteId);
    const tz = ctx.env.TIMEZONE ?? 'UTC';
    try {
      await c.login();
      const uid = crypto.randomUUID();
      const ics = buildVevent(uid, ev, { rrule: opts?.rrule, tz });
      const res = await c.createCalendarObject({
        calendar: { url: ctx.calendar.remoteId ?? '' },
        filename: `${uid}.ics`,
        iCalString: ics,
      });
      if (!res.ok) throw new Error(`create failed (HTTP ${res.status})`);
      const href = res.headers.get('location') ?? `${ctx.calendar.remoteId}${uid}.ics`;
      // The same id sync gives it (with its occurrence), so the next sync doesn't replace the row.
      return (await instanceIn(ics, href, '', ev.start, tz)) ?? { ...ev, externalId: `${href}::${uid}` };
    } catch (err) {
      throw humanError(err);
    }
  },

  // One occurrence (an override in the object, the series untouched) or the whole series; a single
  // event is changed in place. Whatever Kinwall doesn't edit (alarms, attendees, ...) stays.
  async updateEvent(ctx: ProviderCtx, externalId: string, ev: Partial<EventInput>, opts?: WriteOptions): Promise<NormalizedEvent> {
    const config = ctx.account?.config as CaldavConfig | undefined;
    if (!config) throw new Error('CalDAV account is not connected');
    const { href, instanceKey } = splitExternalId(externalId);
    const c = client(ctx.env, config, ctx.calendar.remoteId);
    const tz = ctx.env.TIMEZONE ?? 'UTC';
    try {
      await c.login();
      const existing = await fetchObject(c, ctx, href);
      const data = editCalendarObject(existing.data, instanceKey, { ...ev, ...(opts?.rrule !== undefined ? { rrule: opts.rrule } : {}) }, opts?.scope ?? 'occurrence', tz);
      // If-Match: a change made elsewhere since the read fails the write instead of being overwritten.
      const res = await c.updateCalendarObject({ calendarObject: { url: href, data, etag: existing.etag } });
      if (!res.ok) throw new Error(`update failed (HTTP ${res.status})`);
      const found = ev.start ? await instanceIn(data, href, instanceKey, ev.start, tz) : undefined;
      return found ?? { title: ev.title ?? '', start: ev.start ?? '', end: ev.end ?? '', allDay: ev.allDay ?? false, location: ev.location, description: ev.description, busy: ev.busy, externalId };
    } catch (err) {
      throw humanError(err);
    }
  },

  // The series ('series', or a single event): the object goes. One occurrence: an EXDATE.
  async deleteEvent(ctx: ProviderCtx, externalId: string, opts?: { scope?: WriteScope }): Promise<void> {
    const config = ctx.account?.config as CaldavConfig | undefined;
    if (!config) throw new Error('CalDAV account is not connected');
    const { href, instanceKey } = splitExternalId(externalId);
    const c = client(ctx.env, config, ctx.calendar.remoteId);
    try {
      await c.login();
      if ((opts?.scope ?? 'occurrence') === 'occurrence') {
        const existing = await fetchObject(c, ctx, href);
        const data = deleteOccurrence(existing.data, instanceKey, ctx.env.TIMEZONE ?? 'UTC');
        if (data !== null) {
          const res = await c.updateCalendarObject({ calendarObject: { url: href, data, etag: existing.etag } });
          if (!res.ok) throw new Error(`delete failed (HTTP ${res.status})`);
          return;
        }
      }
      const res = await c.deleteCalendarObject({ calendarObject: { url: href } });
      if (!res.ok && res.status !== 404) throw new Error(`delete failed (HTTP ${res.status})`);
    } catch (err) {
      throw humanError(err);
    }
  },
};
