# G16 follow-up: blackout-conflict edges not solved by the primary commit

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** "G16: Admin add-blackout surfaces existing booking conflicts in two channels (UI warning toast + business-inbox alert email)" (this session's commit).
**Related audit refs:** `docs/audits/admin-comprehensive-audit-2026-05-13.md`; `docs/audits/admin-audit-2026-05-14.md`.

After the primary G16 fix, the add-blackout flow scans for conflicts and warns the admin in two surfaces (UI toast + defensive business-inbox alert). Two edges remain that the primary commit deliberately did not solve. Both are real, both are lower-frequency than the primary case, and both have a discrete fix shape that can ship independently.

## 1. Duration-overlap math: a 4-hour 10:00am booking vs a 1:00pm blackout does not register as a conflict

The primary commit's conflict semantic in `findBookingConflictsForBlackout` (`lib/storage.js`) is exact string match on `time_slot` (blackout `time_slot === booking.time_slot`, OR blackout `time_slot === 'all'`). That misses runtime overlap: a customer who booked the 10:00am slot for a 4-hour charter is on the water until 2:00pm. If the admin then blackouts the 1:00pm slot for that vessel/date, the new conflict scan returns zero hits even though the existing booking physically overlaps the blocked window.

**Fix shape:**

Compute each booking's `[start, end)` window from `time_slot + duration`, compute the blackout's `[start, end)` window from its `time_slot` (`'all'` = full day, otherwise the slot's nominal start + a default block size such as 4h), and declare a conflict whenever the intervals overlap.

`lib/timeslots.js` currently exposes `SLOTS`, `MORNING_SLOTS`, `AFTERNOON_SLOTS`, `isBookable`, `hasMatrixRulesFor`, `bookableSlotsForDuration`, `renderOptions`, and `normalize`. There is **no** existing helper that converts a slot value (e.g. `'10:00am'`, `'11:30am'`) to a numeric start hour (e.g. `10`, `11.5`). The duration-overlap fix will require **creating a new shared helper** in `lib/timeslots.js`, something like `slotToStartHour('11:30am') => 11.5`, and exporting it alongside the current API. Both `findBookingConflictsForBlackout` and any future availability code that needs interval math can then share it.

`duration` is already an integer column on the `bookings` table (see `api/admin.js` allowedFields list at the `handleUpdateBooking` block) and is exposed by the storage helper added in G16.

**Frequency:**

Medium. Most blackouts are full-day (`time_slot === 'all'`), which correctly catches all bookings on that date regardless of duration (the `(ts === 'all') || ...` short-circuit handles them). The miss only fires on per-slot blackouts where a same-day longer booking straddles the blocked slot. Probably a handful per quarter.

## 2. Removing a blackout has no parallel scan or alert

Symmetric concern: `handleRemoveBlackout` (`api/admin.js`) deletes a blackout row with no scan for "what bookings would this re-open the slot for". Functionally different from add-blackout: removing a blackout does not actively conflict with anything (it widens availability), so the business consequence is lower. The scenario where it matters: admin accidentally removes a blackout that was protecting a private maintenance window or a captain's day off, and a new wizard booking lands in the now-open slot before they notice.

**Fix shape (if pursued):**

The cleanest version is a confirmation modal on the admin side ("removing this blackout will re-open `<scope>` to public booking, proceed?") rather than a post-hoc alert email, because the corrective action would be to re-add the blackout immediately and the shorter the loop the better. A more defensive version could additionally check whether the blackout is part of a sequence (e.g. several days in a row, a Friday/Saturday/Sunday cluster) and warn separately, but that is over-engineered for the failure mode.

**Tentative recommendation:**

Leave this one parked indefinitely unless the scenario actually fires. The add-blackout case is the one that produces real customer impact (a paying customer who showed up to a charter the business no longer staffs); the remove-blackout case produces at worst a new bookable slot in a window the admin can re-block. Different urgency tier.

---

## Suggested commit shapes

§1 (duration-overlap): primarily a change to `findBookingConflictsForBlackout` in `lib/storage.js` plus a new shared `slotToStartHour` helper in `lib/timeslots.js` (with an export added to its module surface). Two-file commit. ~30-minute pickup.

§2 (remove-blackout): if pursued, a frontend-only confirmation modal in `admin.html` plus a new server endpoint that returns "future bookings in this scope" without deleting (so the modal can render the impact preview). Larger surface than §1, lower priority, possibly out of scope forever.

Triple-gate cadence: audit → propose → diff → approve → commit.
