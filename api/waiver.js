const {
  createWaiver,
  countWaiversByIpInLastHour,
  findBookingBySessionId,
} = require('../lib/storage');
const { sendWaiverConfirmationEmail } = require('../lib/send-emails');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const RATE_LIMIT_PER_HOUR = 20;

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  return req.headers['x-real-ip']
      || req.headers['cf-connecting-ip']
      || (req.socket && req.socket.remoteAddress)
      || null;
}

function requiredString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// Public-facing booking lookup — returns ONLY the four read-only fields the
// waiver page needs to pre-fill (charter_date, charter_time, vessel,
// organizer_name). Anything else (email, phone, payment, totals) is stripped
// before responding, so a leaked session_id can't expose PII or money data.
async function handleGetInfo(req, res) {
  const session_id = req.query && req.query.session_id;
  if (!session_id) return res.status(400).json({ error: 'session_id required' });
  try {
    const b = await findBookingBySessionId(session_id);
    if (!b) return res.status(404).json({ error: 'Booking not found' });
    return res.status(200).json({
      ok: true,
      booking: {
        session_id:     session_id,
        charter_date:   b.date || null,
        charter_time:   b.time_slot || null,
        vessel:         b.vessel || null,
        organizer_name: b.full_name || b.charter_name || null,
      },
    });
  } catch (err) {
    console.error('waiver lookup error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

async function handlePost(req, res) {
  const ip = clientIp(req);

  // Rate limit by IP — prevents abuse without standing infrastructure.
  // Counts only successful submissions; small charter scale makes this fine.
  try {
    const recent = await countWaiversByIpInLastHour(ip);
    if (recent >= RATE_LIMIT_PER_HOUR) {
      return res.status(429).json({ error: 'Too many waivers from this network in the last hour. Try again later or contact us at (737) 368-1669.' });
    }
  } catch (err) {
    // If the rate-limit query itself fails, log and continue — better to
    // accept a waiver than to lose one because of a counter outage.
    console.error('Rate limit check failed (continuing):', err.message);
  }

  const body = req.body || {};

  // Required fields
  if (!requiredString(body.signer_first_name)) return res.status(400).json({ error: 'First name is required' });
  if (!requiredString(body.signer_last_name))  return res.status(400).json({ error: 'Last name is required' });
  if (!requiredString(body.digital_signature)) return res.status(400).json({ error: 'Digital signature is required' });
  if (!body.terms_acknowledged)                return res.status(400).json({ error: 'You must acknowledge the terms to sign' });

  // Minor handling: if signing for a minor, require guardian fields
  if (body.is_minor) {
    if (!requiredString(body.guardian_name))         return res.status(400).json({ error: 'Guardian name is required when signing for a minor' });
    if (!requiredString(body.guardian_relationship)) return res.status(400).json({ error: 'Guardian relationship is required when signing for a minor' });
  }

  // Compute age from DOB if provided
  let age = null;
  if (body.date_of_birth) {
    const dob = new Date(body.date_of_birth + 'T12:00:00');
    if (!isNaN(dob)) {
      const now = new Date();
      age = now.getFullYear() - dob.getFullYear();
      const m = now.getMonth() - dob.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
    }
  }

  try {
    const waiver = await createWaiver({
      session_id:                     body.session_id || null,
      charter_date:                   body.charter_date || null,
      charter_time:                   body.charter_time || null,
      vessel:                         body.vessel || null,
      organizer_name:                 body.organizer_name || null,
      signer_first_name:              body.signer_first_name.trim(),
      signer_last_name:               body.signer_last_name.trim(),
      signer_email:                   body.signer_email ? String(body.signer_email).trim().toLowerCase() : null,
      signer_phone:                   body.signer_phone || null,
      date_of_birth:                  body.date_of_birth || null,
      age,
      emergency_contact_name:         body.emergency_contact_name || null,
      emergency_contact_phone:        body.emergency_contact_phone || null,
      emergency_contact_relationship: body.emergency_contact_relationship || null,
      is_minor:                       !!body.is_minor,
      guardian_name:                  body.guardian_name || null,
      guardian_relationship:          body.guardian_relationship || null,
      media_release_accepted:         body.media_release_accepted !== false,
      digital_signature:              body.digital_signature.trim(),
      waiver_text_version:            'v1',
      ip_address:                     ip,
      user_agent:                     req.headers['user-agent'] || null,
    });
    // Fire-and-forget the confirmation email so the API response isn't gated
    // on Resend latency. Skipped silently inside the helper if signer_email
    // is missing. Errors are logged but never bubble up to the client.
    if (waiver && waiver.signer_email) {
      sendWaiverConfirmationEmail(waiver).catch(err => {
        console.error('[waiver] confirmation email failed for', waiver.signer_email, '—', err.message);
      });
    }

    return res.status(200).json({ ok: true, waiver_id: waiver && waiver.id });
  } catch (err) {
    console.error('Waiver insert error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method === 'GET')  return handleGetInfo(req, res);
  if (req.method === 'POST') return handlePost(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
};
