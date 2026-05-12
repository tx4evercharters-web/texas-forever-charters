# Lead Delete Feature: Starter Spec

## Status
Queued for fresh-head session. NOT YET DESIGNED. Open product questions below MUST be answered before any code is written.

## The ask (verbatim from DJ, May 12 2026)
"I want to be able to delete leads without having to add context."

## Audit findings (verified May 12 2026)

What currently exists in the codebase:

- **No manual lead deletion UI.** The Leads tab admin.html:4185-4234 has exactly one button per row: "View / edit" or "Log contact." No kebab, no trash icon, no delete action.
- **No lead-delete API endpoint.** `api/admin.js` has no `action=delete-lead` case.
- **One automated lead deletion path exists.** `deleteStaleLeads(days)` in `lib/storage.js:832`, called by `api/cron-reminders.js`. Bulk purge of leads older than 90 days. Not user-triggered.
- **No deletion-reason column exists in Supabase.** The `leads` table has `bounce_reason`, `contact_outcome`, `contact_notes`, `linked_booking_session_id`, plus standard capture fields. None are deletion metadata.
- **Lifecycle alternative exists.** The Log Contact modal lets admin mark leads as Booked, Hard No, Maybe, No Response, Quoted, or Other. This is non-destructive lifecycle tagging, not deletion.

## Why DJ wants manual delete (use cases, May 12 2026)

DJ confirmed all of the following apply:

1. **Spam leads:** obvious junk submissions
2. **Duplicate leads:** same person captured twice
3. **Test entries:** leads DJ created himself during dev/testing
4. **PII removal requests:** customer-initiated deletion requests (right to erasure)

Each use case suggests a different optimal design. A single "delete" button may not be the right answer for all four.

## Open product questions

These MUST be answered before drafting an implementation spec:

### 1. One feature or several?
- Option A: Single "Delete lead" action that covers all four use cases
- Option B: Separate actions per use case (e.g., "Mark as spam" auto-deletes after 30 days, "Merge duplicate" combines records, "Delete test entry" hard-deletes immediately, "GDPR delete" hard-deletes + logs to compliance audit)
- Option C: Single delete action PLUS a "Mark as spam" action that auto-routes through the cron

### 2. Hard delete or soft delete?
- Hard delete: `DELETE FROM leads WHERE id = ?`. Gone forever, immediate.
- Soft delete: add `deleted_at` column, set timestamp, filter out of UI by default, optionally show "recently deleted" view for 30 days, then cron permanently purges
- Soft delete is safer (recoverable from accidents) but adds complexity (schema migration, UI filter, recovery flow)

### 3. Where does the button live?
- Add a kebab dropdown to lead rows (mirrors the bookings tab pattern, just fixed in commit 1678e56)
- Add a trash icon to the action column
- Add to the existing Log Contact modal as a "Delete instead" link
- Add to the lead detail view (if/when one exists)

### 4. Confirmation flow?
- DJ confirmed: keep yes/no confirmation modal, NO required context field
- Open: any optional reason field for the spam/PII cases? (Compliance might benefit from a deletion log even if optional)

### 5. Audit trail?
- Should manual deletions write to an audit log (who deleted what, when, why)?
- If yes, where does the log live (new Supabase table `lead_deletion_log`, append to existing `audit_log`, log to Resend daily digest)?
- If no, then there's no record after deletion, which is fine for spam/test but potentially problematic for PII compliance

### 6. PII compliance specifics
- If a customer requests deletion under CCPA/GDPR-style right to erasure, what's the legal-defensible flow?
- Does TFC have a written privacy policy that commits to a deletion process?
- Recommendation: defer this design decision until/if a real PII removal request comes in. Build the simple spam/test/duplicate delete now, add compliance-grade flow later if needed.

## Recommended next-session sequence

1. DJ answers questions 1-5 above (Q6 deferred)
2. Claude session drafts implementation spec based on answers
3. Spec goes to Claude Code with strict approval gates (audit → propose → diff → commit) given this touches admin destructive actions
4. Schema migration (if soft-delete chosen) ships first, separately from UI commit
5. UI commit ships second
6. Smoke test on admin Leads tab post-deploy

## Estimated effort

- Hard delete + single action + no audit log: 30-45 min Claude Code work
- Soft delete + schema migration + audit log: 90-120 min Claude Code work
- Per-use-case actions (spam / merge / test / PII): full afternoon

## Reference commits for the design pattern

- `1678e56`: Admin kebab dropdown z-index fix (the kebab UI pattern that would extend to leads)
- `bkDelete` flow in admin.html: booking deletion is the closest existing reference for a destructive admin action with confirmation
