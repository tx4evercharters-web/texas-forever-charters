# Follow-up: scope the last-event fetch to bookings being returned

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** "admin audit trail - per-user attribution, field-level diffs on update, last-touched ui..." (this session's commit). Introduced `getLatestEventByBookingId` to power the Bookings table "Last Touched" column.

## The current ceiling

`lib/booking-events.js:getLatestEventByBookingId` fetches the 2000 most-recent `booking_events` rows globally, then JS-side groups by `booking_session_id` keeping the first occurrence (which is the latest per group since the query is `ORDER BY created_at DESC`). The function returns a `{ session_id → event }` map that `handleBookings` joins into each booking row.

Trade-off: when total events lifetime exceeds 2000, the oldest bookings will have `null` last_event and the UI renders `—` in the Last Touched column. Today TFC is nowhere near 2000 — back-of-envelope, ~1-3 events per booking × ~200 lifetime bookings = ~500 events. Headroom for 3-4x growth at current rates.

## The right fix

Scope the events query to only include `booking_session_id` values present in the current `getBookings()` result. Two-step instead of one:

```js
// in handleBookings, after getBookings() resolves:
const sessionIds = bookings.map(b => b.session_id).filter(Boolean);
const events = await request(
  'GET',
  '/booking_events' +
  '?select=booking_session_id,event_type,event_data,created_by,created_at' +
  '&booking_session_id=in.(' + sessionIds.map(encodeURIComponent).join(',') + ')' +
  '&order=created_at.desc'
);
```

With `in.(...)` filter, the query scope is "events for bookings we're about to display" rather than "events globally." The result set is bounded by `events_per_booking × bookings_returned` — ~3 × 200 = ~600 events today, with linear growth tied to bookings volume, not global event volume.

## Why this isn't done in the parent commit

1. Current scale leaves ~4x headroom.
2. The `in.(...)` filter adds URL length — `cs_test_<32 hex>` × 200 = ~7KB URL, well under PostgREST's 16KB default but worth verifying when it ships.
3. The single-query approach is simpler to read and debug.

## Files in scope (when picked up)

- `lib/booking-events.js:getLatestEventByBookingId` — change signature to accept `sessionIds` array, build the `in.(...)` filter, drop the global `&limit=2000`.
- `api/admin.js:handleBookings` — pass the session_id list from the just-resolved `getBookings()` call.

## When to pick up

- Bookings table starts showing `—` in the Last Touched column on rows that should have events.
- Or: lifetime event count crosses ~1500 (use `SELECT count(*) FROM booking_events;`) as a leading indicator.

## Verification when implemented

- Bookings table populates Last Touched for every row that has any event.
- A spot-check SQL query confirms the events-per-booking count is in expected range.
- The URL length for the `in.(...)` filter stays under PostgREST's default limit at 2x current bookings volume.
