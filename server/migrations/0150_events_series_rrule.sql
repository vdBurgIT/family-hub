-- The repeat rule of the series a synced (CalDAV) occurrence belongs to, so the event sheet can show
-- and edit it. Synced rows are already expanded occurrences: this is never expanded again (the rrule
-- column stays a Kinwall calendar's own). Additive, filled in by the next sync.
ALTER TABLE events ADD COLUMN series_rrule TEXT;
