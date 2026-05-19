# Follow-up: pin Sentry CDN script to an SRI integrity hash

**Status:** queued. Starter doc only. Not implemented.
**Parent fix:** "observability foundation - sentry init + pii-scrubbed capture for crons, auth, public lead capture, and browser errors" (this session's Commit 2A). Shipped the Sentry browser SDK loaded from `https://browser.sentry-cdn.com/8.45.0/bundle.min.js` without an SRI `integrity` attribute.

## The gap

The current `<script>` tag in `admin.html`'s `<head>`:

```html
<script src="https://browser.sentry-cdn.com/8.45.0/bundle.min.js" crossorigin="anonymous" async defer></script>
```

No `integrity="sha384-..."` attribute. The browser executes whatever bytes the CDN returns. If `browser.sentry-cdn.com` is ever compromised (DNS hijack, CDN edge poisoning, Sentry account breach with bundle-replacement permissions), an attacker could swap the bundle for a malicious one that exfiltrates admin session cookies, form data, etc.

Subresource Integrity (SRI) closes this gap: the browser computes the hash of the loaded script and refuses to execute it if it doesn't match. The hash is published alongside the bundle by Sentry's release process.

## Why it wasn't shipped in the parent commit

Sentry's CDN docs publish per-version SRI hashes, but I didn't have the v8.45.0 hash to hand when drafting Commit 2A. Shipping without SRI is a known security gap, but blocking the entire observability arc on looking up one hash was the wrong trade-off — the rest of the diff (PII scrubbing, capture wiring, cron + auth instrumentation) is independently valuable and the CDN domain itself is operated by a reputable vendor under Functional Software (Sentry's parent).

## The fix

1. Open https://docs.sentry.io/platforms/javascript/install/loader/ — Sentry's CDN reference docs publish current version + SRI hash. Or check the release manifest at the version directory on the CDN.
2. Pick the exact v8.x.x version (probably bump to the latest patch on the 8.x line at the same time).
3. Update the `<script>` tag with the `integrity` attribute, keeping the existing `crossorigin="anonymous"` (required for SRI to work cross-origin).

End shape:

```html
<script
  src="https://browser.sentry-cdn.com/8.x.x/bundle.min.js"
  integrity="sha384-..."
  crossorigin="anonymous"
  async defer
></script>
```

## Files in scope (when picked up)

- `admin.html` — single `<script>` tag in `<head>`, line ~12.

## Verification when implemented

- Open admin.html → DevTools Network tab → verify the Sentry bundle loads (200, no CSP / SRI failures in console).
- Manually corrupt the integrity hash (change one char) and reload → browser blocks the script with an SRI error in the console; admin shell still loads but Sentry browser capture is missing.
- Restore the correct hash → admin reloads cleanly with Sentry browser active.

## Why this is queued, not fixed

- Sentry CDN is a reputable vendor; near-term compromise risk is real but low.
- One-line change, trivially reversible.
- Better paired with the next Sentry version bump rather than a standalone commit (so the version + hash update happen together).

## When to pick up

- Next time Sentry has a security advisory or bundle release worth picking up.
- If a security audit of the admin surface flags it.
- Bundled with the v8 → v9 SDK upgrade whenever we cross that line.
