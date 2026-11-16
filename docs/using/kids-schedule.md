# Kids' schedule

Which days the kids are home, shown as a strip on each day of the calendar instead of an all-day
event that fills every day. Made for families where the kids live in two homes, and for anything
else that follows a fixed rhythm.

## Making the schedule

On a grown-up's device: **Settings → Family → Kids' schedule → Make a schedule**.

- **What the calendar says**: the words on the strip, like "Kids here".
- **Whose schedule**: the kids it's about. Their faces show on the strip where there's room.
- **Repeats every**: one to four weeks.
- **Week 1 starts**: the first day of the pattern (it snaps to the start of that week).
- Each day is **Here all day**, **Come at…** (from a time on), **Leave at…** (until a time) or
  **Not here**.

A two-week rhythm with a short and a long weekend looks like this, from a Monday:

| Week 1 | | Week 2 | |
|---|---|---|---|
| Monday | Here all day | Monday | Here all day |
| Tuesday | Leave at 6:00 PM | Tuesday | Leave at 6:00 PM |
| Wednesday–Thursday | Not here | Wednesday–Saturday | Not here |
| Friday | Come at 6:00 PM | Sunday | Come at 6:00 PM |
| Saturday–Sunday | Here all day | | |

## On the calendar

Every day shows its strip: filled when the kids are there all day, half filled on the side of the
day they're there when they come or go, with the words on it ("Kids here until 6:00 PM"). On a
phone's month view it's just the house, with an arrow for coming (→🏠) or going (🏠→). The board's
**Today** card starts with the same line.

## Holidays and swaps

Tap a day's strip on the calendar (week, day or schedule view) on a grown-up's device to change
just that date. A changed day has a dashed edge; **Back to the usual schedule** undoes it. The
changes still to come are listed under **Changes for single days** in the settings.

## For other apps

`GET /api/custody` reads the schedule (any device), `PUT /api/custody` saves it or removes it with
`{ "schedule": null }` (grown-ups' devices). See the API reference for the fields.
