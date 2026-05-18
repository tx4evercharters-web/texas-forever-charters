# Follow-up: lazy-load activity log when customer has many events

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** "admin audit trail - per-user attribution, field-level diffs on update, last-touched ui..." (this session's commit). Introduced the Activity History section in `renderCustDetail` + the Activity section in the Edit modal.

## Current behavior

Expanding a customer row in the Customers tab fires `loadCustomerActivity(customerId)` which fetches `/api/admin?action=customer-events&customer_id=<id>` and renders every event for every booking that customer has. No pagination, no "show more" — all events in DOM at once. The `.activity-log` CSS has `max-height: 480px; overflow-y: auto` so the panel never overflows the page; the user scrolls inside the section.

At current scale this is fine. A typical TFC customer has 1-3 bookings × ~3-6 events each = 5-20 events total. Fetch + render is essentially instant. The "Loading…" placeholder is visible for ~200-500ms while the round-trip lands.

The Edit modal's per-booking Activity section has the same behavior (single booking, even smaller event count, never feels slow).

## When this would need attention

- A "long-tail" repeat customer (50+ bookings, hundreds of events) — the fetch payload grows linearly, the render time grows linearly, and the in-section scroll becomes the only navigation. Hypothetical at current TFC scale; would happen if TFC opens to high-frequency repeat charterers.
- The customer-events endpoint starts timing out — `getEventsByCustomerId` is a single PostgREST request, the inner join is well-indexed (foreign keys auto-indexed in Supabase), but at thousands of events per customer the result-set size starts to matter.

## The right fix (when picked up)

Two options depending on scale:

### Option A — paginated "Show more" inside the activity log

Fetch the first N events (e.g., 25), render with a "Show next 25" button at the bottom. Server endpoint takes `&offset=<n>&limit=<n>` params. Frontend tracks loaded count in state, appends rows on click.

Lightweight. Doesn't require backend changes beyond accepting the params.

### Option B — virtualized list

Use a JS virtual-scrolling library (or write one inline — the rows are uniform-height). DOM only renders visible rows. Pure UX fix; backend still returns the full list. Pays the network cost once but the render cost stays bounded.

Only worth it if Option A's button-click latency feels worse than continuous scroll.

## Files in scope (when picked up)

- `lib/booking-events.js:getEventsByCustomerId` — accept optional `limit` + `offset` params.
- `api/admin.js:handleGetCustomerEvents` — pass through query params.
- `admin.html:loadCustomerActivity` — track loaded count, append on "Show more" click.
- `admin.html` CSS — `.activity-log-show-more` button styling.

## Why this is queued, not fixed

- Current scale doesn't feel slow. The "Loading…" placeholder is barely perceptible.
- Building pagination for a hypothetical scale problem is the kind of premature abstraction the CLAUDE.md guidance flags.
- The fix is straightforward when there's actual evidence of slowness.

## When to pick up

- The "Loading…" placeholder is consistently visible long enough to feel like a wait (≥1s).
- A customer's activity log has 100+ events and the section becomes tedious to scroll.
- Network tab shows the `customer-events` request payload exceeding ~100KB.

## Verification when implemented

- Customer detail expand shows the first N events with a clear "Show more" affordance.
- "Show more" click appends the next batch without re-rendering existing rows.
- The Edit modal per-booking section (which never hits this scale) is unaffected — single booking events stay all-at-once.
