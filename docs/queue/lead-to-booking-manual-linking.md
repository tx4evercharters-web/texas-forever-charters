# Follow-up: manual lead-to-booking linking for email-less leads

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** "leads tab - manual lead entry with admin_* source dropdown, added_by attribution, optional contact fields" (this session's commit). Introduced manual lead entry where `customer_email` is optional — relaxes the NOT NULL constraint that the public capture endpoint relied on.

## What changed in the parent commit

`api/capture-lead.js` requires `full_name + customer_email` and writes both on every public exit-intent lead. `api/admin.js:handleAddLead` (new) accepts manual entries with **at least one of** name / email / phone — so a phone-only lead is now a real shape in the `leads` table.

DJ's note in the spec sign-off:
> "Lead-conversion webhook path — matches by email to flip leads to 'converted'. Manual leads with NULL email won't match anything via this path. That's correct behavior (no false positives), but flag in the queue that manual-lead-to-booking linking needs a separate mechanism if/when DJ wants it."

## The webhook path that breaks for email-less leads

`api/stripe-webhook.js` (checkout.session.completed handler) calls `lib/storage.js:findActiveLeadByEmail(customer_email)` to find the most recent non-converted lead for the paying customer's email. If a match is found, the lead's status is flipped to `'converted'` and `linked_booking_session_id` is set.

This is purely email-based matching. A manual lead entered as "Jordan, 555-1234, no email" who later books online doesn't trigger the flip — there's no email to join on. The booking is created cleanly; the lead just stays in `'contacted'` / `'following_up'` / wherever forever.

**Today this is correct behavior, not a bug.** False positives are worse than misses for conversion tracking — auto-converting the wrong lead would poison reporting metrics. So the current state ships safely.

But it does mean DJ has no UX path to manually say "this lead became that booking" once one or the other is missing the join key.

## The fix shape (when picked up)

A "Link to booking" admin action on each lead row in the Leads table, plus a "+ Link to lead" action on each booking row in the Bookings table. Either entry point opens a modal that:

1. Searches for candidate matches (by name fuzzy-match, by phone digits, by date range, by charter context).
2. Lets DJ pick one match (or "none of these — search manually").
3. On confirm: sets `leads.linked_booking_session_id = <booking_session_id>` and `leads.status = 'converted'` and `leads.contact_outcome = 'booked'`. Booking-events row written for the audit trail.

The wiring already exists for the `linked_booking_session_id` column and the `'booked'` outcome — `handleMarkLeadContacted` (`api/admin.js:1346-1433`) does exactly this when an admin logs a Booked outcome with a chosen booking. The "Link to booking" button just routes a different UX entry point through the same backend path.

Existing infrastructure to reuse:
- `lib/storage.js:findBookingsForLead(leadId)` — fuzzy-search bookings by lead's name/email/phone in the last 30 days. Already powers the `lc-booking-picker` in the Log Contact modal.
- `api/admin.js:handleFindBookingsForLead` — endpoint that wraps the above.
- `api/admin.js:handleMarkLeadContacted` — the backend that performs the link + status flip.

## Files in scope (when picked up)

- `admin.html`:
  - Add "Link to booking" button to the Leads tab table row (only for unlinked leads).
  - Reuse the existing booking-picker modal pattern (`lc-booking-picker-wrap`) or build a focused "Link Lead" modal.
  - Add the reverse path on the Bookings table — "+ Link to lead" kebab option that opens a lead-picker.
- `api/admin.js`:
  - Likely no new handler — reuse `handleMarkLeadContacted` with a synthetic outcome=`booked` payload, or add a thin `handleLinkLeadToBooking` that's narrower in scope.
- No schema changes needed; the columns already exist.

## When to pick up

- DJ has enough manual leads in flight that the missed-conversion problem starts to hide real ROI numbers.
- A reporting question surfaces that needs accurate conversion attribution for offline-channel leads.
- DJ asks for it — operational signal beats anticipating.

## Verification when implemented

- Manual lead with no email + later booking under the same name: admin can click "Link to booking", pick the match, status flips to converted.
- Booking row's edit modal shows the linked lead with a "View lead" link.
- Activity log on the booking shows a `lead_linked` event (or similar) with the operator's email in created_by.
- `linked_booking_session_id` is set correctly on the lead row in the database.
