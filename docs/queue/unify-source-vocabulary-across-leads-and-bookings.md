# Follow-up: unify source vocabulary across leads and bookings

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** "leads tab - manual lead entry with admin_* source dropdown, added_by attribution, optional contact fields" (this session's commit). Introduced the admin_* prefix for manual-entry lead sources, deliberately keeping them distinct from the booking-source vocabulary to defer the unification question.

## The current split

Two tables in the same product carry "how did we reach the customer" data with two separate vocabularies.

**`bookings.source`** — 12 values populated by `api/admin.js:handleAddBooking` (the "+ Add Booking" modal at `admin.html:2554-2571`):

```
phone, walkup, referral, repeat_direct, tripadvisor, viator,
peek, fareharbor, instagram, facebook, website, other
```

**`leads.source`** — 11 values populated by two writers:

- `api/capture-lead.js` (public exit-intent endpoint) writes 3 values: `website_exit_intent`, `website_exit_intent_mobile`, `website_stripe_cancel_return`.
- `api/admin.js:handleAddLead` (manual entry from the Leads tab, this commit) writes 8 values: `admin_phone_call`, `admin_text_message`, `admin_instagram_dm`, `admin_facebook_message`, `admin_email`, `admin_in_person`, `admin_referral`, `admin_other`.

The two columns answer conceptually the same question — "how did this customer first reach us" — but with different prefixing conventions, different granularity (booking uses bare `phone` vs. lead's `admin_phone_call`), and different scopes (booking source includes OTAs like TripAdvisor / Viator / Peek / FareHarbor; leads don't track those because leads-to-OTA-bookings isn't a flow that exists today).

## Why this commit deliberately did not unify

1. **Scope creep.** Unification touches the Add Booking modal, `handleAddBooking`, both columns' historic data via UPDATE migrations, the SOURCE_LABELS map in admin.html, and any future reporting / analytics that aggregates by source.
2. **No driving use case yet.** No report or filter needs cross-table source aggregation today. Building a canonical taxonomy without a reporting use case is the kind of premature design the codebase guidance flags.
3. **The admin_* prefix preserves the option to migrate later.** Every manual-entry lead is unambiguously identifiable as "came in via an offline channel" because of its prefix. When a unification effort starts, the migration path is clear: each `admin_*` maps to its non-prefixed equivalent (or stays distinct if the team decides offline-channel attribution matters separately from online).

## What unification would look like (when picked up)

### Step 1 — pick a canonical taxonomy

Open questions:
- **Does "phone" mean "they called to inquire" (lead) vs "they paid by phone for a booking" (current bookings.source)?** Both? Two separate concepts collapsed into the same value, or kept distinct?
- **OTA values** (tripadvisor / viator / peek / fareharbor): leads don't track these because lead-to-OTA isn't a flow. Should they get added to the lead-source vocabulary too, or stay booking-only?
- **`repeat_direct` / `walkup`** in bookings: equivalent to `admin_in_person` for leads, or different? Probably the same idea.
- **Granularity**: does the canonical version keep `instagram_dm` separate from `instagram` (post engagement, generic) or collapse?

### Step 2 — migration

A one-shot SQL migration mapping old values to canonical:

```sql
-- Hypothetical canonical taxonomy
UPDATE leads SET source = 'phone'        WHERE source = 'admin_phone_call';
UPDATE leads SET source = 'instagram'    WHERE source = 'admin_instagram_dm';
UPDATE leads SET source = 'facebook'     WHERE source = 'admin_facebook_message';
UPDATE leads SET source = 'email'        WHERE source = 'admin_email';
UPDATE leads SET source = 'walkup'       WHERE source = 'admin_in_person';
UPDATE leads SET source = 'referral'     WHERE source = 'admin_referral';
UPDATE leads SET source = 'text_message' WHERE source = 'admin_text_message';
UPDATE leads SET source = 'other'        WHERE source = 'admin_other';
-- website_* values stay as-is (or get renamed to a shared "website" + sub-source convention)
```

Plus matching code changes in:
- `api/admin.js:handleAddLead` — drop `admin_` prefix from `ALLOWED_ADMIN_LEAD_SOURCES`.
- `api/admin.js:handleAddBooking` — confirm `ALLOWED_BOOKING_SOURCES` (if it exists; otherwise the dropdown is the only constraint).
- `admin.html` — merge SOURCE_LABELS with the booking-source dropdown labels; both tables read from the same map.
- Any reporting / analytics surfaces — none today.

### Step 3 — Add Booking + Add Lead modals share the same dropdown options

Currently the two modals have completely separate option lists. Unification means they share a single `<datalist>` or shared option-generator function so adding a new source means updating one place.

## Files in scope (when picked up)

- `api/admin.js` — `ALLOWED_ADMIN_LEAD_SOURCES` Set, `handleAddBooking` source validation if any.
- `admin.html` — SOURCE_LABELS map (extend or merge), Add Booking modal source `<select>` at line ~2554, Add Lead modal source `<select>` at line ~2247.
- One-shot SQL migration.
- Any future analytics code that groups by source.

## When to pick up

- A real reporting use case needs cross-table source rollup ("how many leads/bookings came in via Instagram last month, regardless of channel?").
- The double-vocabulary becomes a maintenance pain (third writer added, third prefix introduced).
- Source-by-source conversion-rate analysis is requested.

Until then, the admin_* prefix is doing useful disambiguation work and nothing is broken.

## Verification when implemented

- Both modals' source dropdowns show the same options in the same order.
- SQL spot-check: `SELECT DISTINCT source FROM leads` and `SELECT DISTINCT source FROM bookings` return value sets that are either identical or strictly disjoint (no half-overlap).
- SOURCE_LABELS map has zero entries that aren't used by either table.
