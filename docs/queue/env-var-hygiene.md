# Env-var hygiene cleanup

## The findings

The first real run of /api/env-check on production (post-commit 03868b0) surfaced multiple env-var organization issues via `vercel env ls`:

1. **GOOGLE_REVIEW_URL has 11 stale Preview-branch entries.** Each old feature branch (analytics-upgrade, blackouts-v2, booking-lifecycle, csv-import, customer-crud, customers-tab, damage-hold-and-terms, danes-branch, waiver-system) got its own scoped copy. Those branches are likely merged or deleted. The branch-scoped entries serve no current purpose.

2. **CRON_SECRET has the same 11-branch problem.** Identical stale Preview entries across the same nine old feature branches.

3. **SUPABASE_SECRET_KEY appears 4 times** (Production, Development, Preview, Preview-waiver-system) with slightly different scope splits. SUPABASE_URL appears 3 times. Looks like piecemeal additions over time, now duplicated.

4. **Inconsistent Development-environment coverage.** ANTHROPIC_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY, RESEND_API_KEY, MAILCHIMP_API_KEY, MAILCHIMP_AUDIENCE_ID, ADMIN_PASSWORD all lack Development scope. Only BLOB_READ_WRITE_TOKEN has all three environments. If `vercel dev` is ever used locally, those endpoints would 500.

5. **STRIPE_PUBLISHABLE_KEY is configured server-side.** Normally a frontend-only env var. Either a legitimate server-side use exists (worth confirming) or it's a misconfiguration worth removing.

## Fix shape

Each of these is independent and can ship separately:

- (1) Delete the 9 GOOGLE_REVIEW_URL Preview-branch entries. Keep only the unscoped Preview, Production, Development entries. ~9 dashboard deletions, no code.
- (2) Same fix for CRON_SECRET. Delete the 9 stale Preview-branch entries.
- (3) Deduplicate Supabase entries. Audit which scopes each duplicate uses, consolidate into one entry per scope. Risk: delete the wrong one and break production. Audit-first cadence required.
- (4) Add Development-scope entries for the 7 vars missing it. Use the same values as Production (or stub/sandbox values if any exist for local dev). ~7 dashboard additions.
- (5) Audit STRIPE_PUBLISHABLE_KEY usage. grep across api/ and lib/ for `STRIPE_PUBLISHABLE_KEY`. If found server-side, leave alone. If not, remove the env var entry.

## Why parked

- Not breaking anything in production. Cosmetic dashboard cleanup.
- End-of-day on a long working session is the wrong moment for env-var dashboard surgery. High-risk-low-reward for fatigued judgment.
- Tomorrow-DJ with fresh eyes is the right person to do this.

## Estimated pickup

- (1) + (2): ~5 minutes combined. Pure dashboard work, low risk.
- (3): ~15 minutes with audit-first cadence. Highest risk of accidentally breaking production if rushed.
- (4): ~5 minutes. Low risk.
- (5): ~10 minutes including the audit grep.

Total: ~35 minutes if all five are done in one session, but they're individually small and independent. Could pickup one at a time.

## Verification path

After each fix, re-run `vercel env ls` and `/api/env-check` to confirm:
- env ls output is cleaner
- env-check still shows all required = true
- Any optional vars added to Development scope show up under env ls

Cross-reference today's commit (03868b0) by message title.
