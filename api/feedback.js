const { postToResend } = require('../lib/send-emails');
const { findBookingBySessionId } = require('../lib/storage');

const FROM_EMAIL     = 'Texas Forever Charters <bookings@texasforevercharters.com>';
const BUSINESS_EMAIL = 'tx4evercharters@gmail.com';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function starString(n) {
  const r = Math.max(0, Math.min(5, parseInt(n) || 0));
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T12:00:00');
  if (isNaN(d)) return str;
  const days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const rating  = parseInt(body.rating, 10);
  const comment = (body.comment || '').toString().trim().slice(0, 4000);
  const session_id = body.session_id ? String(body.session_id) : null;
  const name_in    = body.name    ? String(body.name).trim().slice(0, 200)    : '';
  const email_in   = body.email   ? String(body.email).trim().toLowerCase()   : '';

  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating (1-5) required' });
  }
  if (!comment) {
    return res.status(400).json({ error: 'Comment required' });
  }
  if (!process.env.RESEND_API_KEY) {
    console.error('[feedback] RESEND_API_KEY not configured');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Look up the booking when we have a session_id so the email is enriched
  // with charter context. Lookup failures shouldn't block the feedback path.
  let booking = null;
  if (session_id) {
    try { booking = await findBookingBySessionId(session_id); }
    catch (err) { console.error('[feedback] booking lookup failed:', err.message); }
  }

  const customerName  = (booking && booking.full_name) || name_in || 'Anonymous';
  const customerEmail = (booking && booking.customer_email) || email_in || '';
  const customerPhone = (booking && booking.phone) || '';
  const charterDate   = booking && booking.date ? formatDate(booking.date) : '—';
  const vessel        = booking && booking.vessel ? booking.vessel : '—';
  const experience    = booking && booking.experience ? booking.experience : '—';

  const subject = 'Charter Feedback — ' + customerName + ' — ' + charterDate + ' — ' + rating + ' stars';

  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;background:#F0F2F8;padding:20px;">' +
      '<div style="background:#1B2A6B;padding:24px;text-align:center;border-radius:10px 10px 0 0;">' +
        '<div style="font-size:18px;font-weight:900;color:#FFFFFF;letter-spacing:3px;text-transform:uppercase;">Charter Feedback</div>' +
      '</div>' +
      '<div style="background:#FFFFFF;padding:28px;border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB;">' +
        '<div style="font-size:36px;letter-spacing:6px;color:#F59E0B;text-align:center;margin-bottom:12px;">' + starString(rating) + '</div>' +
        '<div style="font-size:14px;color:#6B7280;text-align:center;margin-bottom:24px;">' + rating + ' out of 5</div>' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size:14px;color:#1B2A6B;">' +
          '<tr><td style="padding:6px 0;width:38%;color:#6B7280;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;">Customer</td><td style="padding:6px 0;font-weight:600;">' + escapeHtml(customerName) + '</td></tr>' +
          '<tr><td style="padding:6px 0;color:#6B7280;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;">Email</td><td style="padding:6px 0;font-weight:600;">' + escapeHtml(customerEmail || '—') + '</td></tr>' +
          '<tr><td style="padding:6px 0;color:#6B7280;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;">Phone</td><td style="padding:6px 0;font-weight:600;">' + escapeHtml(customerPhone || '—') + '</td></tr>' +
          '<tr><td style="padding:6px 0;color:#6B7280;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;">Charter Date</td><td style="padding:6px 0;font-weight:600;">' + escapeHtml(charterDate) + '</td></tr>' +
          '<tr><td style="padding:6px 0;color:#6B7280;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;">Vessel</td><td style="padding:6px 0;font-weight:600;">' + escapeHtml(vessel) + '</td></tr>' +
          '<tr><td style="padding:6px 0;color:#6B7280;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;">Experience</td><td style="padding:6px 0;font-weight:600;">' + escapeHtml(experience) + '</td></tr>' +
          (session_id ? '<tr><td style="padding:6px 0;color:#6B7280;font-size:11px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;">Session</td><td style="padding:6px 0;font-weight:600;font-family:monospace;font-size:12px;">' + escapeHtml(session_id) + '</td></tr>' : '') +
        '</table>' +
        '<div style="margin-top:24px;padding:18px;background:#F8F9FC;border-left:3px solid #C8102E;border-radius:4px;">' +
          '<div style="font-size:11px;font-weight:700;color:#C8102E;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">Customer Comment</div>' +
          '<div style="font-size:14px;color:#1F2937;line-height:1.7;white-space:pre-wrap;">' + escapeHtml(comment) + '</div>' +
        '</div>' +
      '</div>' +
      '<div style="background:#1B2A6B;padding:16px;text-align:center;border-radius:0 0 10px 10px;font-size:12px;color:rgba(255,255,255,0.6);">' +
        'Sent via feedback.html &bull; Texas Forever Charters' +
      '</div>' +
    '</div>';

  try {
    const result = await postToResend({
      from:     FROM_EMAIL,
      to:       [BUSINESS_EMAIL],
      reply_to: customerEmail || BUSINESS_EMAIL,
      subject,
      html,
    });
    console.log('[feedback] sent to', BUSINESS_EMAIL, 'rating:', rating, 'session:', session_id, 'resend_id:', result.id);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[feedback] send failed:', err.message);
    return res.status(502).json({ error: 'Failed to send feedback', detail: err.message });
  }
};
