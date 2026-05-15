-- Phase 2 migration: customer portal foundation + booking_events audit log
-- ============================================================================
-- This migration is purely additive. No existing columns are dropped or renamed.
-- portal_token coexists with session_id; it does NOT replace it. Existing webhook
-- code, admin tooling, and customer-facing flows continue to use session_id as
-- before. portal_token is the new public-facing identifier for the customer
-- portal URLs (e.g., /booking/<portal_token>).
--
-- Backfill scope: portal_token is generated only for bookings with a future
-- charter date. Past charters do not need portal access. The booking_events
-- backfill captures a minimum 'booking_created' event for every existing row.
--
-- Token format: 16-byte cryptographically-random hex (32 chars). Generated via
-- pgcrypto's gen_random_bytes (extension pre-enabled on Supabase Postgres).
--
-- Column naming note: the bookings table uses `date` and `time_slot` for the
-- charter day and start time (NOT `charter_date` / `charter_time` — those live
-- on the `waivers` table). The portal_token backfill filters on `date`.
--
-- Timestamp note: bookings use `booked_at` as the canonical creation timestamp
-- (always set at insert). The booking_events backfill reads booked_at directly,
-- with COALESCE to now() only as a defensive guard against any null rows.
--
-- booking_events.booking_session_id is intentionally NOT a foreign key.
-- This preserves the audit trail even if a booking is hard-deleted (although
-- soft-delete via deleted_at is the standard going forward per G13).
--
-- Idempotency: every ALTER / CREATE uses IF NOT EXISTS so the migration is
-- safe to re-run. The CHECK constraint add uses a DO block guard since
-- Postgres ALTER TABLE ADD CONSTRAINT does not support IF NOT EXISTS directly.
--
-- Application code that writes to booking_events on state changes is deferred
-- to a separate Phase 2.5 commit. After this migration lands, the table exists
-- and has historical events, but new events are NOT yet being written.
-- ============================================================================

-- 1. Add 9 new columns to bookings (additive, defensive)

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS portal_token              text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_link_url          text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_link_id           text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_link_status       text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_link_amount_cents integer;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_link_created_at   timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS balance_payment_intent_id text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS damage_overflow_intent_id text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deleted_at                timestamptz;

-- 2. payment_link_status CHECK constraint
-- Postgres ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS variant, so the
-- DO block guards against re-running the migration after the constraint
-- already exists.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bookings_payment_link_status_check'
  ) THEN
    ALTER TABLE bookings
      ADD CONSTRAINT bookings_payment_link_status_check
      CHECK (payment_link_status IS NULL OR payment_link_status IN ('none', 'pending', 'paid', 'expired'));
  END IF;
END $$;

-- 3. Unique partial index on portal_token
-- NULL portal_tokens are allowed and not deduped (a future booking that
-- pre-dates the portal-token backfill or a past-dated booking will have NULL).
-- Among non-null values, the index enforces global uniqueness.

CREATE UNIQUE INDEX IF NOT EXISTS bookings_portal_token_idx
  ON bookings (portal_token)
  WHERE portal_token IS NOT NULL;

-- 4. booking_events audit log table

CREATE TABLE IF NOT EXISTS booking_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_session_id text NOT NULL,
  event_type         text NOT NULL,
  event_data         jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  created_by         text
);

-- 5. Indexes on booking_events
-- booking_session_id: timeline lookup for a given booking.
-- created_at DESC: recent-events listing across all bookings (admin dashboard).

CREATE INDEX IF NOT EXISTS booking_events_booking_session_id_idx
  ON booking_events (booking_session_id);

CREATE INDEX IF NOT EXISTS booking_events_created_at_idx
  ON booking_events (created_at DESC);

-- 6. Backfill portal_token for future bookings
-- 16 random bytes hex-encoded = 32-char token = 128 bits of entropy.
-- Skips past-dated charters (no portal access needed) and skips rows that
-- somehow already have a portal_token (idempotent re-run safety).

UPDATE bookings
   SET portal_token = encode(gen_random_bytes(16), 'hex')
 WHERE portal_token IS NULL
   AND date >= CURRENT_DATE;

-- 7. Backfill synthetic 'booking_created' events for existing bookings
-- One event per existing booking, timestamped at booked_at. The backfilled
-- flag in event_data lets downstream consumers distinguish historical
-- backfill from live writes. Skips rows without a session_id (defensive —
-- session_id is the table's effective primary identifier and should never
-- be null, but the WHERE clause makes the migration safe even if it is).

INSERT INTO booking_events (booking_session_id, event_type, event_data, created_at, created_by)
SELECT
  session_id,
  'booking_created',
  jsonb_build_object('backfilled', true, 'source', 'phase2_migration'),
  COALESCE(booked_at, now()),
  'system'
FROM bookings
WHERE session_id IS NOT NULL;

-- 8. Grants per Oct 30 2026 Supabase Data API policy
-- service_role: this app's only DB caller (lib/storage.js uses SUPABASE_SECRET_KEY).
-- authenticated: future-proofing for when Supabase auth is wired up; harmless now.
-- Anon role intentionally not granted — booking_events should never be readable
-- from a browser even via PostgREST.

GRANT SELECT, INSERT, UPDATE ON booking_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON booking_events TO service_role;

-- 9. Enable RLS on booking_events (defense in depth)
-- No policies defined = only service_role can access via the SUPABASE_SECRET_KEY.
-- Anon and authenticated roles get GRANT'd above for future use but RLS blocks
-- their actual access until policies are explicitly written. Matches the pattern
-- used for the leads table per api/capture-lead.js:13.

ALTER TABLE booking_events ENABLE ROW LEVEL SECURITY;
