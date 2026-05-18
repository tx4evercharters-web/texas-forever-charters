/* lib/auth.js — admin session auth.
 *
 * Replaces the shared-password Bearer token auth that lived here before. The
 * flow is now:
 *
 *   1. Admin clicks Google Sign-In on /admin.html.
 *   2. Google Identity Services returns a JWT ID token to the browser.
 *   3. Browser POSTs the id_token to /api/auth-google.
 *   4. verifyGoogleIdToken (this file) validates the token via Google's keys.
 *   5. The verified email is checked against ADMIN_WHITELIST.
 *   6. signSessionCookie produces an HMAC-signed cookie value carrying the
 *      email + iat + exp. The cookie is httpOnly + Secure + SameSite=Lax,
 *      30-day TTL, scoped to *.texasforevercharters.com in production.
 *   7. Subsequent /api/admin?action=* requests verify the cookie via
 *      requireAuth, which also re-checks the whitelist on every request so
 *      removing an email from ADMIN_WHITELIST takes effect immediately
 *      instead of waiting up to 30 days for cookie expiry.
 *
 * The cookie format is JWT-shaped without the JWT header — we control both
 * ends, so we drop the algorithm-negotiation envelope and HMAC-sign the
 * base64url-encoded payload directly. Same security properties as a real JWT
 * with HS256, ~half the wire size, no jsonwebtoken dependency.
 *
 * Display names come from ADMIN_DISPLAY_NAMES (format:
 * "email:Name,email:Name"). The session cookie stores only the email; the
 * name is re-derived on verify so renaming an admin via env var takes effect
 * on next request, not next login.
 *
 * Env vars consumed:
 *   GOOGLE_CLIENT_ID       — audience for ID token verification
 *   ADMIN_JWT_SECRET       — HMAC key for session cookies (rotate to log
 *                            everyone out)
 *   ADMIN_WHITELIST        — comma-separated list of authorized emails
 *   ADMIN_DISPLAY_NAMES    — "email:Name,email:Name" friendly-name map
 */

const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const SESSION_COOKIE_NAME = 'tfc_admin_session';
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/* ── Whitelist + display names ───────────────────────────────────── */

function getWhitelistedEmails() {
  const raw = (process.env.ADMIN_WHITELIST || '').trim();
  if (!raw) return [];
  return raw.split(',').map(s => s.toLowerCase().trim()).filter(Boolean);
}

function getDisplayName(email) {
  const lower = String(email || '').toLowerCase().trim();
  if (!lower) return '';
  const raw = (process.env.ADMIN_DISPLAY_NAMES || '').trim();
  if (!raw) return email;
  for (const entry of raw.split(',')) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx < 0) continue;
    const k = entry.slice(0, colonIdx).toLowerCase().trim();
    const v = entry.slice(colonIdx + 1).trim();
    if (k === lower && v) return v;
  }
  return email;
}

/* ── Google ID token verification ────────────────────────────────── */

async function verifyGoogleIdToken(idToken) {
  const clientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID not set');
  if (!idToken) return null;
  const client = new OAuth2Client(clientId);
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken, audience: clientId });
  } catch (err) {
    /* Bad signature, expired token, wrong audience — all collapse to null.
       Caller surfaces a generic "Access denied" so a probe can't
       distinguish failure modes. */
    return null;
  }
  const payload = ticket && ticket.getPayload && ticket.getPayload();
  if (!payload || !payload.email || !payload.email_verified) return null;
  return { email: String(payload.email).toLowerCase().trim() };
}

/* ── Session cookie sign / verify ────────────────────────────────── */

function signSessionCookie({ email }) {
  const secret = (process.env.ADMIN_JWT_SECRET || '').trim();
  if (!secret) throw new Error('ADMIN_JWT_SECRET not set');
  if (!email) throw new Error('signSessionCookie: email required');
  const now = Math.floor(Date.now() / 1000);
  const payload = { email: String(email).toLowerCase().trim(), iat: now, exp: now + SESSION_TTL_SECONDS };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return payloadB64 + '.' + sig;
}

function verifySessionCookie(value) {
  const secret = (process.env.ADMIN_JWT_SECRET || '').trim();
  if (!secret || !value) return null;
  const dot = value.indexOf('.');
  if (dot < 1 || dot === value.length - 1) return null;
  const payloadB64 = value.slice(0, dot);
  const providedSig = value.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  let sigOk = false;
  try {
    const a = Buffer.from(providedSig);
    const b = Buffer.from(expectedSig);
    sigOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return null;
  }
  if (!sigOk) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || !payload.email) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) return null;
  const email = String(payload.email).toLowerCase().trim();
  return { email, name: getDisplayName(email) };
}

/* ── Cookie header helpers ───────────────────────────────────────── */

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part.slice(eq + 1).trim();
    try { out[k] = decodeURIComponent(v); }
    catch { out[k] = v; }
  }
  return out;
}

/* Cookie Domain attribute. In production (host is the apex domain or any
   subdomain of texasforevercharters.com) we scope to .texasforevercharters.com
   so the cookie covers apex + www + future subdomains. In preview deploys
   (host is *.vercel.app) or localhost we omit Domain entirely so the cookie
   stays host-only — preventing a preview-domain cookie from leaking onto
   production via the apex redirect, and avoiding browser rejections for
   Domain attributes that don't match the request host. */
function cookieDomainAttr(req) {
  const host = String((req && req.headers && req.headers.host) || '').toLowerCase().split(':')[0];
  if (host === 'texasforevercharters.com' || host.endsWith('.texasforevercharters.com')) {
    return '; Domain=.texasforevercharters.com';
  }
  return '';
}

function setSessionCookieHeader(res, req, cookieValue) {
  const cookie = SESSION_COOKIE_NAME + '=' + cookieValue +
    '; Path=/; Max-Age=' + SESSION_TTL_SECONDS +
    '; HttpOnly; Secure; SameSite=Lax' +
    cookieDomainAttr(req);
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookieHeader(res, req) {
  const cookie = SESSION_COOKIE_NAME + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' +
    cookieDomainAttr(req);
  res.setHeader('Set-Cookie', cookie);
}

/* ── requireAuth ─────────────────────────────────────────────────── */

/* Returns the user object on success ({ email, name }), or null after
   sending a 401 response. Re-checks the whitelist on every request so an
   email removed from ADMIN_WHITELIST is locked out immediately instead of
   waiting for cookie expiry. */
function getUserFromRequest(req) {
  const cookies = parseCookies(req.headers && req.headers.cookie);
  const sessionValue = cookies[SESSION_COOKIE_NAME];
  if (!sessionValue) return null;
  const user = verifySessionCookie(sessionValue);
  if (!user) return null;
  const whitelist = getWhitelistedEmails();
  if (whitelist.length === 0 || !whitelist.includes(user.email)) return null;
  return user;
}

function requireAuth(req, res) {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Unauthorized' });
    return null;
  }
  return user;
}

module.exports = {
  SESSION_COOKIE_NAME,
  getWhitelistedEmails,
  getDisplayName,
  verifyGoogleIdToken,
  signSessionCookie,
  verifySessionCookie,
  setSessionCookieHeader,
  clearSessionCookieHeader,
  getUserFromRequest,
  requireAuth,
};
