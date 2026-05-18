# Follow-up: amount_total cents-vs-dollars storage convention audit

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** "admin audit trail - per-user attribution, field-level diffs on update, last-touched ui..." (this session's commit). The activity-log diff renderer for `amount_total` and `remaining_balance` papers over this with a magnitude heuristic; the real fix is consistent storage.

## The drift

The codebase stores monetary values in two different units depending on the field and the code path:

- `bookings.amount_total` — **cents** (integer). Set from Stripe Checkout Sessions' `amount_total` field which Stripe returns in the smallest currency unit. Webhook handlers (`api/stripe-webhook.js`) write cents directly; the admin Edit form's "Amount Paid" input shows `paidNow.toFixed(2)` after dividing by 100 (admin.html:6641).
- `bookings.remaining_balance`, `bookings.grand_total`, `bookings.charter_subtotal`, `bookings.admin_fee`, `bookings.tax_amount`, `bookings.processing_fee`, `bookings.promo_discount`, `bookings.add_on_total`, `bookings.deposit_amount`, `bookings.refund_amount`, `bookings.damage_charge_amount` — **dollars** (decimal). Set by the admin form and the booking wizard via `lib/pricing.js`, which works in dollars.

The split has held since the original Stripe integration shipped — it pre-dates this commit. Most read sites cope by hard-coding the conversion at the display layer:

- `admin.html:5574` — `b.amount_total ? b.amount_total/100 : 0` for the Bookings table Total column.
- `admin.html:5641` — `(b.amount_total || 0) / 100` for the Edit modal Amount Paid input.
- `lib/send-emails.js` formatters convert per-call.
- `api/admin.js` various handlers do `Number(...) / 100` ad hoc.

## What this commit added

The activity-log diff renderer (`formatFieldValue` in admin.html) needs to format `from`/`to` values for the user-visible diff text. For `amount_total`:

```js
if (field === 'amount_total' || field === 'remaining_balance') {
  const n = Number(val);
  if (Number.isNaN(n)) return String(val);
  /* amount_total is in cents in the DB but remaining_balance is in
     dollars. Detect by magnitude — values >= 1000 are almost
     certainly cents (a $100+ booking total in cents = 10000+),
     while remaining balances under $10000 stay as dollars. Both
     render the same way after the conversion. */
  const dollars = (field === 'amount_total' && n >= 1000) ? n / 100 : n;
  return fmtMoney(dollars);
}
```

The `n >= 1000` heuristic handles ~99% of real charters ($200-$3500 stored as cents = 20000-350000, all >= 1000). The failure mode is a test booking or tiny refund where `amount_total` is stored as something like 500 cents ($5.00) — the heuristic incorrectly leaves it un-divided and renders "$500.00" instead of "$5.00". Admin-only surface, not customer-facing, not blocking. The comment in the helper documents this.

## The real fix

Pick one convention (probably dollars, since that's what 11 of the 12 monetary columns use) and normalize the outlier:

### Option A — convert amount_total to dollars at write time

Easier to ship. Touches:

1. `api/stripe-webhook.js` — every site that writes `amount_total` from `session.amount_total` adds a `/ 100` before the insert/patch.
2. `lib/storage.js` — any helper that writes `amount_total` from Stripe data.
3. Migration: `UPDATE bookings SET amount_total = amount_total / 100 WHERE amount_total IS NOT NULL;`
4. Remove the `/ 100` conversions from read sites:
   - `admin.html:5574`, `5641`, the activity-log heuristic
   - Email templates and PDF generators
   - Admin handlers that read `amount_total`
5. Booking wizard / customer-facing displays that read this field.

Risk: the migration is one-shot — if it runs twice the values are wrong by another factor of 100. Wrap in a guard: `WHERE amount_total > 99 OR amount_total IS NULL` or similar magnitude check.

### Option B — convert everything to cents

More compatible with Stripe APIs (no conversion when handing values back to Stripe), but inverts 11 fields' storage. More disruptive migration and more breakage if any consumer is missed. Not recommended.

## Files in scope (when picked up)

- `api/stripe-webhook.js` — primary writer of `amount_total` in cents.
- `lib/storage.js` — any helper writing `amount_total` (search: `amount_total:`).
- `admin.html` — `5574`, `5641`, `formatFieldValue` heuristic, and any other `amount_total / 100` site.
- `lib/send-emails.js` — `formatMoneyDollars` callers that touch `amount_total`.
- `api/admin.js` — handlers like `handleChargeRemaining`, `handleRefundBooking` that compute against `amount_total`.
- `api/portal-checkout.js`, `booking-portal.html` — customer-facing payment surfaces.
- Booking wizard pages — `index.html` add-ons and totals if they ever read `amount_total`.

Plus a one-shot SQL migration with a magnitude guard.

## Why this is queued, not fixed

- Heuristic ships an acceptable UX for the activity log today.
- Real fix touches ~10 files and a data migration.
- No customer impact from the current state — every customer-facing display does the conversion correctly today.
- Best done when there's an unrelated reason to touch the storage/serialization layer (e.g., a Stripe API version bump, a refactor of pricing.js).

## Verification when implemented

- All monetary columns in `bookings` use the same unit. SQL spot-check: `SELECT amount_total, grand_total, remaining_balance FROM bookings LIMIT 10;` — values should be on the same magnitude scale across the row.
- Activity log diff renderer drops the `n >= 1000` heuristic and just calls `fmtMoney(n)`.
- Email and admin UI still display the right dollar amounts.
- New bookings from Stripe webhook record `amount_total` consistent with all other money fields.
