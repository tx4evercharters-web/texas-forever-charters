const https = require('https');

const FROM_EMAIL = 'Texas Forever Charters <bookings@texasforevercharters.com>';
const BUSINESS_EMAIL = 'tx4evercharters@gmail.com';

// Public waiver page on our own site. Each customer gets a session-specific
// link that pre-fills charter info; this generic URL is the fallback / public
// link guests can use if they didn't get the session-specific one.
const SITE_BASE  = process.env.SITE_BASE_URL || 'https://www.texasforevercharters.com';
const WAIVER_URL = SITE_BASE + '/waiver.html';
function waiverLinkFor(session_id) {
  return session_id ? WAIVER_URL + '?session_id=' + encodeURIComponent(session_id) : WAIVER_URL;
}

/* Customer portal URL base. Derived from SITE_BASE so a domain change is a
   single edit. Matches the www. convention used everywhere else on the site;
   the no-www vs www debate is a separate site-wide normalization. Phase 2.5
   (commit 103c286) auto-generates portal_token at booking insert for both
   wizard and admin paths, so the helper below should return a valid URL for
   every modern booking. portalUrlFor returns null for the legacy edge case
   (pre-Phase-2.5 rows that somehow lack a token, or any race condition where
   token generation failed silently) so callers can guard their portal-link
   sections rather than rendering a broken anchor. */
const PORTAL_BASE_URL = SITE_BASE + '/booking/';
function portalUrlFor(b) {
  if (!b || !b.portal_token) return null;
  return PORTAL_BASE_URL + b.portal_token;
}

/* ── Resend HTTP helper ── */
function postToResend(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (upstream) => {
      let data = '';
      upstream.on('data', chunk => { data += chunk; });
      upstream.on('end', () => {
        if (upstream.statusCode >= 200 && upstream.statusCode < 300) {
          resolve(JSON.parse(data));
        } else {
          reject(new Error('Resend ' + upstream.statusCode + ': ' + data));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/* ── Formatters ── */
function formatDate(str) {
  if (!str) return '—';
  const d = new Date(str + 'T12:00:00');
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

// Returns the formatted "balance due" date — 14 days before the charter date.
// Returns null if charterDateStr can't be parsed so callers can omit the line.
function balanceDueDate(charterDateStr) {
  if (!charterDateStr) return null;
  const charter = new Date(charterDateStr + 'T12:00:00');
  if (isNaN(charter)) return null;
  const due = new Date(charter.getTime() - 14 * 24 * 60 * 60 * 1000);
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return days[due.getDay()] + ', ' + months[due.getMonth()] + ' ' + due.getDate() + ', ' + due.getFullYear();
}

function vesselLabel(v) {
  return v === 'yacht' ? '40ft Carver Aft Cabin' : '24ft Bentley Navigator 243';
}

/* US currency formatter with thousands separators. Two helpers:
   formatMoney(cents)         → "$2,706.25" from cents-input
   formatMoneyDollars(dollars) → "$2,706.25" from dollars-input
   Both handle null/NaN/string input (parse to float, default 0) and
   convert ASCII hyphen-minus on negatives to the proper U+2212. */
const _moneyFmt = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
function formatMoneyDollars(v) {
  let n = (typeof v === 'string') ? parseFloat(v) : v;
  if (n == null || isNaN(n)) n = 0;
  return _moneyFmt.format(n).replace(/^-/, '−');
}
function formatMoney(cents) {
  if (cents == null || isNaN(cents)) cents = 0;
  return formatMoneyDollars(cents / 100);
}

function parseAddOns(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

function addOnLines(addOns) {
  const lines = [];
  if (addOns.drone)        lines.push('Drone Footage — $200');
  if (addOns.towels > 0)   lines.push('Towels (' + addOns.towels + ' x $8) — $' + (addOns.towels * 8));
  if (addOns.water)        lines.push('Water Bottles — $25');
  if (addOns.ice)          lines.push('Ice — $25');
  if (addOns.beerpong)     lines.push('Beer Pong Setup — $50');
  return lines;
}

/* ── Shared HTML primitives ── */
function emailWrapper(inner) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Texas Forever Charters</title></head>' +
    '<body style="margin:0;padding:0;background:#F0F2F8;font-family:Arial,Helvetica,sans-serif;">' +
    '<div style="max-width:600px;margin:0 auto;padding:20px 16px;">' +
    inner +
    '</div></body></html>';
}

function emailHeader() {
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
    '<tr><td style="background:#1B2A6B;padding:26px 32px;border-radius:10px 10px 0 0;text-align:center;">' +
    '<div style="font-size:22px;font-weight:900;color:#FFFFFF;letter-spacing:4px;' +
      'text-transform:uppercase;font-family:Arial,sans-serif;">TEXAS FOREVER CHARTERS</div>' +
    '<div style="font-size:11px;font-weight:700;color:rgba(255,255,255,0.5);letter-spacing:3px;' +
      'text-transform:uppercase;margin-top:5px;">Lake Travis &bull; Austin, TX</div>' +
    '<div style="width:48px;height:3px;background:#C8102E;margin:14px auto 0;border-radius:2px;"></div>' +
    '</td></tr></table>';
}

function emailFooter() {
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
    '<tr><td style="background:#1B2A6B;padding:24px 32px;border-radius:0 0 10px 10px;text-align:center;">' +
    '<div style="font-size:12px;color:rgba(255,255,255,0.5);line-height:1.8;">' +
    '&copy; Texas Forever Charters &nbsp;&bull;&nbsp; Lake Travis, Austin TX<br>' +
    '<a href="tel:+17373681669" style="color:rgba(255,255,255,0.7);text-decoration:none;">(737) 368-1669</a>' +
    ' &nbsp;&bull;&nbsp; ' +
    '<a href="mailto:tx4evercharters@gmail.com" style="color:rgba(255,255,255,0.7);text-decoration:none;">' +
      'tx4evercharters@gmail.com</a>' +
    '</div>' +
    '</td></tr></table>';
}

function detailTable(rows) {
  let html = '<table width="100%" cellpadding="0" cellspacing="0" border="0">';
  rows.forEach(function(row, i) {
    const borderTop = i === 0 ? 'none' : '1px solid #EEF0F6';
    html += '<tr>' +
      '<td style="padding:10px 0;border-top:' + borderTop + ';width:38%;vertical-align:top;">' +
        '<span style="font-size:11px;font-weight:700;color:#6B7280;letter-spacing:1.5px;text-transform:uppercase;">' +
          row[0] + '</span>' +
      '</td>' +
      '<td style="padding:10px 0;border-top:' + borderTop + ';vertical-align:top;">' +
        '<span style="font-size:14px;color:#1B2A6B;font-weight:600;">' + (row[1] || '&mdash;') + '</span>' +
      '</td>' +
      '</tr>';
  });
  html += '</table>';
  return html;
}

function sectionBox(title, content, bgColor) {
  bgColor = bgColor || '#FFFFFF';
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
    '<tr><td style="background:' + bgColor + ';padding:24px 32px;border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB;">' +
    '<div style="font-size:10px;font-weight:700;color:#C8102E;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;">' +
      title + '</div>' +
    content +
    '</td></tr></table>';
}

function divider() {
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
    '<tr><td style="height:1px;background:#E5E7EB;font-size:0;">&nbsp;</td></tr></table>';
}

/* ── Customer confirmation email ── */
function buildCustomerEmail(d) {
  const addOns = parseAddOns(d.add_ons);
  const addOnList = addOnLines(addOns);
  const amountPaid = formatMoney(d.amount_total);
  const grandTotal = parseFloat(d.grand_total || 0);
  const remaining = grandTotal > 0
    ? Math.max(0, grandTotal - d.amount_total / 100)
    : 0;

  // Hero
  let html = emailHeader();
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:32px;">&#9975;</div>' +
    '<div style="font-size:28px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">' +
      "You're on the Water!" +
    '</div>' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.6);line-height:1.7;">' +
      'Your charter is confirmed and your date is locked in.<br>' +
      'We can&rsquo;t wait to see you on Lake Travis.' +
    '</div>' +
    '</td></tr></table>';

  // Booking details
  html += sectionBox('Booking Details', detailTable([
    ['Charter Name',  d.charter_name],
    ['Vessel',        vesselLabel(d.vessel)],
    ['Experience',    d.experience],
    ['Date',          formatDate(d.date)],
    ['Start Time',    d.time_slot],
    ['Duration',      d.duration ? d.duration + ' hours' : ''],
    ['Party Size',    d.party_size ? d.party_size + ' guests' : ''],
  ]));

  html += divider();

  // Add-ons
  if (addOnList.length > 0) {
    const addOnRows = addOnList.map(function(line) {
      return '<div style="font-size:14px;color:#1B2A6B;font-weight:600;padding:5px 0;">' +
        '&#10003; ' + line + '</div>';
    }).join('');
    html += sectionBox('Add-Ons', addOnRows);
    html += divider();
  }

  // Payment summary
  let paymentHtml = '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>';
  paymentHtml += '<td width="50%" style="vertical-align:top;padding-right:8px;">' +
    '<div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:16px;text-align:center;">' +
    '<div style="font-size:10px;font-weight:700;color:#15803D;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">Paid Today</div>' +
    '<div style="font-size:26px;font-weight:900;color:#16A34A;font-family:Arial,sans-serif;">' + amountPaid + '</div>' +
    '<div style="font-size:11px;color:#6B7280;margin-top:4px;">' +
      (d.payment_type === 'deposit' ? 'Deposit &mdash; date secured' : 'Paid in full') +
    '</div>' +
    '</div></td>';

  if (remaining > 0) {
    paymentHtml += '<td width="50%" style="vertical-align:top;padding-left:8px;">' +
      '<div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;padding:16px;text-align:center;">' +
      '<div style="font-size:10px;font-weight:700;color:#B45309;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">Remaining Balance</div>' +
      '<div style="font-size:26px;font-weight:900;color:#D97706;font-family:Arial,sans-serif;">' + formatMoneyDollars(remaining) + '</div>' +
      '<div style="font-size:11px;color:#6B7280;margin-top:4px;">Due 7 days before charter</div>' +
      '</div></td>';
  } else {
    paymentHtml += '<td width="50%" style="vertical-align:top;padding-left:8px;">' +
      '<div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:16px;text-align:center;">' +
      '<div style="font-size:10px;font-weight:700;color:#15803D;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">Balance Due</div>' +
      '<div style="font-size:26px;font-weight:900;color:#16A34A;font-family:Arial,sans-serif;">$0.00</div>' +
      '<div style="font-size:11px;color:#6B7280;margin-top:4px;">Paid in full &mdash; nothing owed</div>' +
      '</div></td>';
  }
  paymentHtml += '</tr></table>';

  const dueDate = balanceDueDate(d.date);
  if (remaining > 0) {
    paymentHtml += '<div style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:8px;' +
      'padding:12px 16px;margin-top:14px;font-size:13px;color:#92400E;line-height:1.6;">' +
      '<strong>Reminder:</strong> Your remaining balance of <strong>' + formatMoneyDollars(remaining) + '</strong> ' +
      'is due <strong>14 days before your charter</strong>' +
      (dueDate ? ' &mdash; <strong>' + dueDate + '</strong>' : '') + '. ' +
      'We&rsquo;ll reach out ahead of time to collect. Questions? Call us at (737) 368-1669.' +
      '</div>';
  }

  html += sectionBox('Payment Summary', paymentHtml);
  html += divider();

  // Damage deposit hold reminder
  html += sectionBox('Damage Deposit Hold',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'A <strong>$250 damage deposit hold</strong> has been placed on your card. ' +
      'This is a pre-authorization only &mdash; <strong>no funds are withdrawn</strong> unless damage occurs during your charter. ' +
      'The hold will be released within <strong>48 hours</strong> after your charter if no damage is reported.' +
    '</div>');
  html += divider();

  // Liability waiver — every guest must sign before boarding
  const sessionWaiverLink = waiverLinkFor(d.session_id);
  html += sectionBox('IMPORTANT — All Guests Must Sign the Waiver Before Boarding',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Please share the link below with everyone in your party. ' +
      '<strong>Each guest must sign individually before your charter date.</strong>' +
      '<div style="text-align:center;margin:16px 0 6px;">' +
        '<a href="' + sessionWaiverLink + '" style="display:inline-block;background:#1B2A6B;color:#FFFFFF;' +
          'font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
          'text-decoration:none;padding:12px 24px;border-radius:6px;">Sign the Waiver</a>' +
      '</div>' +
      '<div style="font-size:12px;color:#6B7280;text-align:center;word-break:break-all;">' + sessionWaiverLink + '</div>' +
      '<div style="font-size:12px;color:#6B7280;margin-top:12px;text-align:center;">' +
        'Generic waiver page (no charter details pre-filled): ' +
        '<a href="' + WAIVER_URL + '" style="color:#1B2A6B;">' + WAIVER_URL + '</a>' +
      '</div>' +
    '</div>');
  html += divider();

  /* Booking portal CTA. Placed after the waiver block (most urgent action)
     and before the gratuity reminder (informational only) so the customer
     reads: confirm + book details → urgent waiver action → portal as the
     home for everything else → gratuity heads-up → what happens next.
     Entirely omitted when portal_token is missing — defensive guard for
     legacy rows. Navy button matches existing waiver-CTA pattern. */
  const portalUrl = portalUrlFor(d);
  if (portalUrl) {
    html += sectionBox('Manage Your Charter Online',
      '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
        'Your booking portal is your home for the charter. Check directions to the dock, see your waiver status, review what to bring, and pay your balance whenever you\'re ready.' +
        '<div style="text-align:center;margin:16px 0 6px;">' +
          '<a href="' + portalUrl + '" style="display:inline-block;background:#1B2A6B;color:#FFFFFF;' +
            'font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
            'text-decoration:none;padding:13px 28px;border-radius:6px;">View Your Booking Portal</a>' +
        '</div>' +
        '<div style="font-size:12px;color:#6B7280;text-align:center;word-break:break-all;">' + portalUrl + '</div>' +
      '</div>');
    html += divider();
  }

  /* Captain's gratuity reminder — surfaces the 20% cash/Zelle/Venmo
     requirement that's not collected through Stripe. Amber background
     (#FFFBEB) draws the eye against the surrounding white sections;
     structural pattern is the standard sectionBox so the email's
     design language stays consistent. */
  html += sectionBox("💵 Captain's Gratuity (20% Minimum) — Day of Charter",
    '<div style="font-size:14px;color:#92400E;line-height:1.7;">' +
      'Gratuity is paid directly to your captain on the <strong>day of your charter</strong> &mdash; ' +
      '<strong>cash, Zelle, or Venmo</strong>. ' +
      'This is required and <strong>not collected through your booking total</strong>.' +
    '</div>',
    '#FFFBEB');
  html += divider();

  // Next steps
  const steps = [
    ['Check your email', 'A Stripe receipt has been sent separately. Check your spam if you don&rsquo;t see it.'],
    ['We&rsquo;ll call you', 'Expect a call or text from your captain 48 hours before departure to confirm details.'],
    ['Show up &amp; enjoy', 'Meet at <strong>Volente Beach Waterpark &amp; Resort</strong>. Arrive 15 min early. BYOB welcome. Your charter includes <strong>complimentary access</strong> to Volente Beach Waterpark &mdash; come early or stay after to enjoy it. Just mention Texas Forever Charters at the gate.'],
  ];
  let stepsHtml = '';
  steps.forEach(function(s, i) {
    stepsHtml += '<div style="display:flex;margin-bottom:' + (i < steps.length - 1 ? '14' : '0') + 'px;">' +
      '<div style="width:28px;height:28px;min-width:28px;border-radius:50%;background:#C8102E;' +
        'color:#FFFFFF;font-size:12px;font-weight:700;display:flex;align-items:center;' +
        'justify-content:center;margin-right:12px;margin-top:1px;text-align:center;' +
        'line-height:28px;">' + (i + 1) + '</div>' +
      '<div>' +
        '<div style="font-size:14px;font-weight:700;color:#1B2A6B;margin-bottom:2px;">' + s[0] + '</div>' +
        '<div style="font-size:13px;color:#6B7280;line-height:1.5;">' + s[1] + '</div>' +
      '</div></div>';
  });
  html += sectionBox('What Happens Next', stepsHtml);
  html += divider();

  // CTA
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#FFFFFF;padding:24px 32px;text-align:center;' +
      'border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB;">' +
    '<a href="tel:+17373681669" style="display:inline-block;background:#C8102E;color:#FFFFFF;' +
      'font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
      'text-decoration:none;padding:13px 28px;border-radius:6px;">' +
      'Questions? Call (737) 368-1669' +
    '</a>' +
    '</td></tr></table>';
  html += divider();
  html += emailFooter();

  return emailWrapper(html);
}

/* ── Business notification email ── */
function buildBusinessEmail(d) {
  const addOns = parseAddOns(d.add_ons);
  const addOnList = addOnLines(addOns);
  const amountPaid = formatMoney(d.amount_total);
  const grandTotal = parseFloat(d.grand_total || 0);
  const remaining = grandTotal > 0
    ? Math.max(0, grandTotal - d.amount_total / 100)
    : 0;

  let html = emailHeader();

  // Alert banner
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#C8102E;padding:16px 32px;text-align:center;">' +
    '<div style="font-size:16px;font-weight:900;color:#FFFFFF;letter-spacing:2px;text-transform:uppercase;">' +
      '&#128276; New Booking Received' +
    '</div>' +
    '</td></tr></table>';

  // Quick stats
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:18px 32px;border-left:1px solid rgba(200,16,46,0.25);' +
      'border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.9;">' +
    '<strong style="color:#FFFFFF;">' + (d.charter_name || '—') + '</strong>' +
    ' &nbsp;&bull;&nbsp; ' + vesselLabel(d.vessel) +
    ' &nbsp;&bull;&nbsp; ' + formatDate(d.date) +
    ' &nbsp;&bull;&nbsp; ' + (d.time_slot || '—') +
    ' &nbsp;&bull;&nbsp; ' + (d.duration || '?') + ' hrs' +
    '</div>' +
    '</td></tr></table>';

  // Booking details
  html += sectionBox('Booking Details', detailTable([
    ['Charter Name',  d.charter_name],
    ['Vessel',        vesselLabel(d.vessel)],
    ['Experience',    d.experience],
    ['Date',          formatDate(d.date)],
    ['Start Time',    d.time_slot],
    ['Duration',      d.duration ? d.duration + ' hours' : ''],
    ['Party Size',    d.party_size ? d.party_size + ' guests' : ''],
  ]));

  html += divider();

  // Customer contact info
  html += sectionBox('Customer Details', detailTable([
    ['Full Name',   d.full_name],
    ['Email',       d.customer_email || '—'],
    ['Phone',       d.phone],
  ]));

  html += divider();

  // Special requests
  if (d.special_requests) {
    html += sectionBox('Special Requests',
      '<div style="font-size:14px;color:#374151;line-height:1.7;font-style:italic;">' +
        d.special_requests + '</div>');
    html += divider();
  }

  // Add-ons
  if (addOnList.length > 0) {
    const addOnRows = addOnList.map(function(line) {
      return '<div style="font-size:14px;color:#1B2A6B;font-weight:600;padding:5px 0;">' +
        '&#10003; ' + line + '</div>';
    }).join('');
    html += sectionBox('Add-Ons', addOnRows);
    html += divider();
  }

  // Payment info
  let payHtml = detailTable([
    ['Payment Type',   d.payment_type === 'deposit' ? 'Deposit (10%)' : 'Paid in Full'],
    ['Amount Paid',    amountPaid],
    ['Remaining',      remaining > 0 ? formatMoneyDollars(remaining) + ' (due 7 days before charter)' : '$0.00 — fully paid'],
    ['Total Value',    d.grand_total ? formatMoneyDollars(d.grand_total) : '—'],
    ['Promo Applied',  d.promo_applied === 'true' ? 'Yes (10% off)' : 'No'],
  ]);
  html += sectionBox('Payment Details', payHtml);
  html += divider();
  html += emailFooter();

  return emailWrapper(html);
}

/* Plain-text alert sent to the business when the customer-facing
   confirmation fails so the team has a paper trail to follow up on. */
function buildEmailFailureAlertHtml(data, errMessage, customerEmail) {
  return '<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#FEF2F2;border:2px solid #C8102E;border-radius:8px;">' +
    '<div style="font-size:18px;font-weight:900;color:#991B1B;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">⚠ Customer Confirmation Email Failed</div>' +
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Stripe charged the customer successfully but the confirmation email to <strong>' + (customerEmail || '(missing)') + '</strong> failed to send.<br><br>' +
      '<strong>Action needed:</strong> Reach out to the customer manually so they know the booking is confirmed.' +
    '</div>' +
    '<div style="margin-top:16px;padding:14px;background:#FFFFFF;border-radius:6px;font-size:13px;color:#1F2937;line-height:1.7;">' +
      '<div><strong>Customer:</strong> ' + (data.full_name || '—') + '</div>' +
      '<div><strong>Email:</strong> ' + (customerEmail || '—') + '</div>' +
      '<div><strong>Phone:</strong> ' + (data.phone || '—') + '</div>' +
      '<div><strong>Charter:</strong> ' + (data.charter_name || '—') + '</div>' +
      '<div><strong>Date:</strong> ' + formatDate(data.date) + '</div>' +
      '<div><strong>Vessel:</strong> ' + (data.vessel ? vesselLabel(data.vessel) : '—') + '</div>' +
      '<div><strong>Session:</strong> <code>' + (data.session_id || '—') + '</code></div>' +
    '</div>' +
    '<div style="margin-top:14px;padding:12px;background:#1F2937;color:#FCA5A5;border-radius:6px;font-family:monospace;font-size:12px;word-break:break-all;">' +
      'Resend error: ' + (errMessage || '(unknown)') +
    '</div>' +
  '</div>';
}

/* ── Main export ── */
async function sendConfirmationEmails(data) {
  const sid = data.session_id;
  console.log('[send-emails] sendConfirmationEmails called',
    'session:', sid,
    '| customer:', data.customer_email,
    '| charter:', data.charter_name,
    '| date:',    data.date,
    '| RESEND_API_KEY set?', !!process.env.RESEND_API_KEY);

  if (!process.env.RESEND_API_KEY) {
    const err = new Error('RESEND_API_KEY not configured');
    console.error('[send-emails] FATAL', sid, err.message);
    throw err;
  }

  const customerSubject = 'Booking Confirmed: ' + (data.charter_name || 'Your Charter') +
    ' — ' + formatDate(data.date);
  const businessSubject = 'New Booking: ' + (data.charter_name || '?') +
    ' | ' + (data.experience || '') + ' | ' + formatDate(data.date);

  const customerEmail = data.customer_email;

  /* Both sends are attempted independently. A failure on the customer email
     used to throw and skip the business notification, leaving owners with no
     awareness that a paid booking had even happened. Now we always try the
     business email, and if customer delivery fails we send a follow-up
     alert so the team can reach out manually. */
  let customerResult = null, customerError = null;
  let businessResult = null, businessError = null;

  if (customerEmail) {
    console.log('[send-emails] Sending customer confirmation', sid, '→', customerEmail);
    try {
      customerResult = await postToResend({
        from:     FROM_EMAIL,
        to:       [customerEmail],
        reply_to: BUSINESS_EMAIL,
        subject:  customerSubject,
        html:     buildCustomerEmail(data),
      });
      console.log('[send-emails] Customer email OK', sid, 'resend_id:', customerResult.id);
    } catch (err) {
      customerError = err;
      console.error('[send-emails] CUSTOMER EMAIL FAILED', sid, '→', customerEmail, '|', err.message, '\n', err.stack);
    }
  } else {
    customerError = new Error('No customer email in session data');
    console.error('[send-emails] CUSTOMER EMAIL SKIPPED', sid, '— no customer_email');
  }

  console.log('[send-emails] Sending business notification', sid, '→', BUSINESS_EMAIL);
  try {
    businessResult = await postToResend({
      from:     FROM_EMAIL,
      to:       [BUSINESS_EMAIL],
      reply_to: customerEmail || BUSINESS_EMAIL,
      subject:  businessSubject,
      html:     buildBusinessEmail(data),
    });
    console.log('[send-emails] Business email OK', sid, 'resend_id:', businessResult.id);
  } catch (err) {
    businessError = err;
    console.error('[send-emails] BUSINESS EMAIL FAILED', sid, '|', err.message, '\n', err.stack);
  }

  /* If only the customer email failed, fire a best-effort alert to the
     business so the team has visibility. Failure of the alert itself is
     not fatal — we log it. */
  if (customerError && !businessError) {
    try {
      const alertSubject = '⚠ ACTION NEEDED: Confirmation email FAILED — ' +
        (data.full_name || customerEmail || 'unknown customer') + ' — ' + formatDate(data.date);
      await postToResend({
        from:     FROM_EMAIL,
        to:       [BUSINESS_EMAIL],
        reply_to: BUSINESS_EMAIL,
        subject:  alertSubject,
        html:     buildEmailFailureAlertHtml(data, customerError.message, customerEmail),
      });
      console.log('[send-emails] Failure-alert email sent to', BUSINESS_EMAIL, sid);
    } catch (alertErr) {
      console.error('[send-emails] Could not send failure alert', sid, '|', alertErr.message);
    }
  }

  /* Throw only if BOTH failed so the caller (stripe-webhook) sees the
     problem in logs. Stripe has already charged, so we still return 200
     to avoid retry loops; the webhook handles that. */
  if (customerError && businessError) {
    const e = new Error('Both customer and business confirmation emails failed: ' +
      'customer=' + customerError.message + ' | business=' + businessError.message);
    e.customerError = customerError;
    e.businessError = businessError;
    throw e;
  }

  return { customerResult, businessResult, customerError, businessError };
}

/* ── G15 — admin-action email-failure defensive alert ──────────────────
   Mirrors the wizard-confirmation ACTION NEEDED alert (buildEmailFailure
   AlertHtml + the inline send inside sendConfirmationEmails) but for
   admin-initiated actions (cancel, refund, damage capture, charge card,
   add booking). Five admin handlers currently return email_warning in
   their 200 response when the customer email fails. The admin UI now
   surfaces that via a warning toast; this defensive alert is the second
   surface — admin's inbox gets a paper trail so a missed toast doesn't
   leave the customer in the dark. */

const ADMIN_ACTION_LABELS = {
  'cancel-booking':        { headline: 'Cancellation email failed',         body: 'The booking was cancelled successfully but the customer cancellation email failed to send.',          action: 'Reach out to the customer manually so they know their booking is cancelled.' },
  'refund-booking':        { headline: 'Refund email failed',               body: 'The refund was processed successfully but the customer refund email failed to send.',                action: 'Reach out to the customer manually so they know their refund is processed.' },
  'capture-damage-charge': { headline: 'Damage charge email failed',        body: 'The damage charge was captured successfully but the customer damage-charge email failed to send.', action: 'Reach out to the customer manually so they know the charge happened.' },
  'charge-remaining':      { headline: 'Balance charge email failed',       body: 'The remaining balance was charged successfully but the customer confirmation email failed to send.', action: 'Reach out to the customer manually so they know their card was charged.' },
  'add-booking':           { headline: 'Booking confirmation email failed', body: 'The booking was saved successfully but the customer confirmation email failed to send.',             action: 'Reach out to the customer manually so they know their booking is on the books.' },
  'send-payment-link':     { headline: 'Payment link email failed',         body: 'The Stripe payment link was created successfully but the delivery email to the customer failed to send.', action: 'Reach out to the customer manually so they can pay their balance. The link does exist in Stripe — you can copy it from the Stripe dashboard or click Send Payment Link again on this booking to retry.' },
  /* G17: customer-side waiver-confirmation email after a successful
     waiver signature. Signature row is durable in Supabase before this
     email runs, so the row itself is never the failure surface here. */
  'waiver-signed':         { headline: 'Waiver-confirmation email failed',  body: 'The customer signed the waiver successfully but the confirmation email failed to send.',                action: 'Reach out to the customer manually so they have a copy of their signed waiver. The signature is recorded in our system; only the receipt email failed.' },
};

function buildAdminActionFailureAlertHtml(actionType, booking, intendedRecipient, errorMessage) {
  const a = ADMIN_ACTION_LABELS[actionType] || { headline: 'Admin action email failed', body: 'An admin action completed but a customer email failed to send.', action: 'Reach out manually.' };
  return '<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#FEF2F2;border:2px solid #C8102E;border-radius:8px;">' +
    '<div style="font-size:18px;font-weight:900;color:#991B1B;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">&#9888; ' + a.headline + '</div>' +
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      a.body + '<br><br>' +
      '<strong>Action needed:</strong> ' + a.action +
    '</div>' +
    '<div style="margin-top:16px;padding:14px;background:#FFFFFF;border-radius:6px;font-size:13px;color:#1F2937;line-height:1.7;">' +
      '<div><strong>Action:</strong> <code>' + actionType + '</code></div>' +
      '<div><strong>Customer:</strong> ' + (booking.full_name || '—') + '</div>' +
      '<div><strong>Email:</strong> ' + (intendedRecipient || booking.customer_email || '—') + '</div>' +
      '<div><strong>Phone:</strong> ' + (booking.phone || '—') + '</div>' +
      '<div><strong>Charter:</strong> ' + (booking.charter_name || '—') + '</div>' +
      '<div><strong>Date:</strong> ' + formatDate(booking.date) + '</div>' +
      '<div><strong>Vessel:</strong> ' + (booking.vessel ? vesselLabel(booking.vessel) : '—') + '</div>' +
      '<div><strong>Session:</strong> <code>' + (booking.session_id || '—') + '</code></div>' +
    '</div>' +
    '<div style="margin-top:14px;padding:12px;background:#1F2937;color:#FCA5A5;border-radius:6px;font-family:monospace;font-size:12px;word-break:break-all;">' +
      'Resend error: ' + (errorMessage || '(unknown)') +
    '</div>' +
  '</div>';
}

async function sendAdminActionEmailFailureAlert(actionType, booking, intendedRecipient, errorMessage) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const a = ADMIN_ACTION_LABELS[actionType] || { headline: 'Admin action email failed' };
  const subject = '⚠ ACTION NEEDED: ' + a.headline + ' — ' +
    (booking.full_name || intendedRecipient || 'unknown customer') + ' — ' + formatDate(booking.date);
  console.log('[send-emails] Sending admin-action failure alert to:', BUSINESS_EMAIL, '| action:', actionType, '| session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [BUSINESS_EMAIL],
    reply_to: BUSINESS_EMAIL,
    subject,
    html:     buildAdminActionFailureAlertHtml(actionType, booking, intendedRecipient, errorMessage),
  });
  console.log('[send-emails] Admin-action failure alert sent OK. Resend id:', result.id);
  return result;
}

/* G16: admin add-blackout conflict surfacing. Distinct alert from G15's
   admin-action email-failure alert (different trigger, different audience
   action). Subject prefix matches G15's "ACTION NEEDED" convention so the
   business inbox treats both consistently. Recipient is BUSINESS_EMAIL
   only; affected customers are NEVER on this thread. Empty-cell fallback
   uses '&ndash;' rather than the codebase's customer-facing '&mdash;' to
   stay consistent with project writing rules for new internal surfaces. */
function buildBlackoutConflictAlertHtml({ blackout, conflicts }) {
  const date    = blackout.date;
  const vScope  = (blackout.vessel === 'both') ? 'Both vessels' : vesselLabel(blackout.vessel);
  const tsScope = (blackout.time_slot === 'all') ? 'All slots' : blackout.time_slot;
  const n       = conflicts.length;
  const cardsHtml = conflicts.map((c, i) => {
    const phoneCell = c.phone
      ? '<a href="tel:' + c.phone + '" style="color:#1F2937;">' + c.phone + '</a>'
      : '&ndash;';
    const emailCell = c.customer_email
      ? '<a href="mailto:' + c.customer_email + '" style="color:#1F2937;">' + c.customer_email + '</a>'
      : '&ndash;';
    return '<div style="margin-top:14px;padding:14px;background:#FFFFFF;border-radius:6px;font-size:13px;color:#1F2937;line-height:1.7;">' +
      '<div style="font-weight:700;color:#991B1B;margin-bottom:6px;">Booking ' + (i + 1) + ' of ' + n + '</div>' +
      '<div><strong>Customer:</strong> ' + (c.full_name || '&ndash;') + '</div>' +
      '<div><strong>Phone:</strong> ' + phoneCell + '</div>' +
      '<div><strong>Email:</strong> ' + emailCell + '</div>' +
      '<div><strong>Charter:</strong> ' + (c.charter_name || '&ndash;') + '</div>' +
      '<div><strong>Vessel:</strong> ' + (c.vessel ? vesselLabel(c.vessel) : '&ndash;') + '</div>' +
      '<div><strong>Time slot:</strong> ' + (c.time_slot || '&ndash;') + '</div>' +
      '<div><strong>Status:</strong> ' + (c.status || '&ndash;') + '</div>' +
      '<div><strong>Session ID:</strong> <code>' + (c.session_id || '&ndash;') + '</code></div>' +
    '</div>';
  }).join('');
  return '<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;background:#FEF2F2;border:2px solid #C8102E;border-radius:8px;">' +
    '<div style="font-size:18px;font-weight:900;color:#991B1B;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">&#9888; Blackout blocked existing bookings</div>' +
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'You just blocked <strong>' + formatDate(date) + '</strong> (' + vScope + ' / ' + tsScope + '). The blackout was saved, but ' + n + ' active booking(s) already exist for that scope. The customers were NOT notified.<br><br>' +
      '<strong>Action needed:</strong> Reach out to each customer below and decide whether to honor the booking or cancel + refund it.' +
    '</div>' +
    '<div style="margin-top:16px;padding:14px;background:#FFFFFF;border-radius:6px;font-size:13px;color:#1F2937;line-height:1.7;">' +
      '<div><strong>Blackout date:</strong> ' + formatDate(date) + '</div>' +
      '<div><strong>Vessel scope:</strong> ' + vScope + '</div>' +
      '<div><strong>Time slot scope:</strong> ' + tsScope + '</div>' +
      '<div><strong>Conflicts:</strong> ' + n + '</div>' +
    '</div>' +
    cardsHtml +
  '</div>';
}

async function sendBlackoutConflictAlert({ blackout, conflicts }) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const vScope  = (blackout.vessel === 'both') ? 'Both vessels' : vesselLabel(blackout.vessel);
  const tsScope = (blackout.time_slot === 'all') ? 'all slots' : blackout.time_slot;
  const n = conflicts.length;
  const subject = '⚠ ACTION NEEDED: Blackout conflicts ' + n + ' existing booking' + (n === 1 ? '' : 's') +
    ' / ' + formatDate(blackout.date) + ' / ' + vScope + ' / ' + tsScope;
  console.log('[send-emails] Sending blackout-conflict alert to:', BUSINESS_EMAIL, '| date:', blackout.date, '| vessel:', blackout.vessel, '| slot:', blackout.time_slot, '| conflicts:', n);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [BUSINESS_EMAIL],
    reply_to: BUSINESS_EMAIL,
    subject,
    html:     buildBlackoutConflictAlertHtml({ blackout, conflicts }),
  });
  console.log('[send-emails] Blackout-conflict alert sent OK. Resend id:', result.id);
  return result;
}

/* ── Lifecycle: cancellation + refund emails ── */

function bookingDetailsBlock(b) {
  return sectionBox('Booking Details', detailTable([
    ['Vessel',     vesselLabel(b.vessel)],
    ['Experience', b.experience],
    ['Date',       formatDate(b.date)],
    ['Start Time', b.time_slot],
  ]));
}

function buildCancellationEmail(b) {
  const name = (b.full_name || '').split(' ')[0] || 'there';
  let html = emailHeader();
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:28px;">&#9888;&#65039;</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">Booking Cancelled</div>' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.7;">' +
      'Your charter has been cancelled.' +
    '</div></td></tr></table>';

  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Hi ' + name + ',<br><br>' +
      'Your charter on <strong>' + formatDate(b.date) + '</strong> has been cancelled. ' +
      'If you have any questions, please call or text us at ' +
      '<a href="tel:+17373681669" style="color:#C8102E;text-decoration:none;font-weight:700;">(737) 368-1669</a>.' +
    '</div>');
  html += divider();
  html += bookingDetailsBlock(b);
  html += divider();
  html += emailFooter();
  return emailWrapper(html);
}

function buildRefundEmail(b, refundDollars, isFullRefund, remainingDollars) {
  const name = (b.full_name || '').split(' ')[0] || 'there';
  const headline = isFullRefund ? 'Refund Processed' : 'Partial Refund Processed';
  const refundFmt = formatMoneyDollars(refundDollars);

  let html = emailHeader();
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:28px;">&#128176;</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">' + headline + '</div>' +
    '<div style="font-size:32px;font-weight:900;color:#16A34A;font-family:Arial,sans-serif;margin-top:8px;">' +
      refundFmt + '</div>' +
    '</td></tr></table>';

  let messageBody;
  if (isFullRefund) {
    messageBody =
      'Hi ' + name + ',<br><br>' +
      'Your full refund of <strong>' + refundFmt + '</strong> has been processed. ' +
      'Please allow <strong>5&ndash;10 business days</strong> for it to appear on your statement.';
  } else {
    messageBody =
      'Hi ' + name + ',<br><br>' +
      'A partial refund of <strong>' + refundFmt + '</strong> has been processed. ' +
      'Your remaining balance for the charter on <strong>' + formatDate(b.date) + '</strong> is ' +
      '<strong>' + formatMoneyDollars(remainingDollars) + '</strong>. ' +
      'Please allow <strong>5&ndash;10 business days</strong> for the refund to appear on your statement.';
  }

  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' + messageBody + '</div>');
  html += divider();
  html += bookingDetailsBlock(b);
  html += divider();
  html += emailFooter();
  return emailWrapper(html);
}

async function sendCancellationEmail(booking) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendCancellationEmail: no customer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending cancellation email to:', booking.customer_email, 'session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'Your Texas Forever Charters Booking Has Been Cancelled',
    html:     buildCancellationEmail(booking),
  });
  console.log('[send-emails] Cancellation email sent OK. Resend id:', result.id);
  return result;
}

async function sendRefundEmail(booking, refundDollars, isFullRefund, remainingDollars) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendRefundEmail: no customer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const subject = isFullRefund
    ? 'Your Refund Has Been Processed — Texas Forever Charters'
    : 'Your Partial Refund Has Been Processed — Texas Forever Charters';
  console.log('[send-emails] Sending', isFullRefund ? 'full' : 'partial', 'refund email to:', booking.customer_email, 'session:', booking.session_id, '| amount:', formatMoneyDollars(refundDollars));
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject,
    html:     buildRefundEmail(booking, refundDollars, isFullRefund, remainingDollars),
  });
  console.log('[send-emails] Refund email sent OK. Resend id:', result.id);
  return result;
}

function buildDamageChargeEmail(b, chargeDollars) {
  const name = (b.full_name || '').split(' ')[0] || 'there';
  const chargeFmt = formatMoneyDollars(chargeDollars);

  let html = emailHeader();
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:28px;">&#9888;&#65039;</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">Damage Charge Applied</div>' +
    '<div style="font-size:32px;font-weight:900;color:#C8102E;font-family:Arial,sans-serif;margin-top:8px;">' +
      chargeFmt + '</div>' +
    '</td></tr></table>';

  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Hi ' + name + ',<br><br>' +
      'A damage charge of <strong>' + chargeFmt + '</strong> has been applied to your card on file ' +
      'for your charter on <strong>' + formatDate(b.date) + '</strong>. ' +
      'If you have any questions, please call us at ' +
      '<a href="tel:+17373681669" style="color:#C8102E;text-decoration:none;font-weight:700;">(737) 368-1669</a>.' +
    '</div>');
  html += divider();
  html += bookingDetailsBlock(b);
  html += divider();
  html += emailFooter();
  return emailWrapper(html);
}

async function sendDamageChargeEmail(booking, chargeDollars) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendDamageChargeEmail: no customer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending damage charge email to:', booking.customer_email, 'session:', booking.session_id, '| amount:', formatMoneyDollars(chargeDollars));
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'Damage Charge Applied — Texas Forever Charters',
    html:     buildDamageChargeEmail(booking, chargeDollars),
  });
  console.log('[send-emails] Damage charge email sent OK. Resend id:', result.id);
  return result;
}

/* ── Full waiver agreement text (v1) — kept here so signers receive a
   permanent, self-contained copy. Mirror this string with waiver.html
   when the legal team revises the agreement. ── */
const WAIVER_TEXT_V1_HTML = `
  <h3>Texas Forever Charters, LLC — Liability Waiver and Release Agreement</h3>

  <h3>1. Assumption of Risk</h3>
  <p>I acknowledge that participation in boating and related recreational activities aboard the vessel operated by Texas Forever Charters, LLC involves <strong>inherent risks</strong>, including but not limited to slips, falls, drowning, collisions, sun exposure, and bodily injury. I voluntarily assume all such risks, whether anticipated or not. These risks apply whether I am swimming, using paddle boards or float mats, jumping off the vessel, climbing, consuming alcohol, or participating in any other activity while on or near the vessel.</p>

  <h3>2. Rules, Conduct &amp; Compliance</h3>
  <ul>
    <li><strong>Alcohol:</strong> Guests 21+ may bring their own alcohol. Underage drinking is prohibited.</li>
    <li>No illegal drugs or unauthorized substances. Violation results in immediate removal and possible legal action.</li>
    <li>No glass containers on deck (glass permitted in yacht cabin only).</li>
    <li>No standing while vessel is underway.</li>
    <li>No limbs outside railings while underway.</li>
    <li>No littering.</li>
    <li>No smoking anything that produces ash on the vessel. Vaping is permitted on deck. Smoking is permitted in the water or on float mats while anchored.</li>
    <li>No nudity.</li>
    <li>No sexual activity.</li>
    <li>Reckless or unsafe behavior may result in removal without refund.</li>
  </ul>

  <h3>3. Health, Safety &amp; Medical</h3>
  <p>I certify that I am physically and mentally fit. USCG-approved life jackets are available for all guests. <strong>Children under 13 must wear one</strong> while on deck unless inside the cabin. I acknowledge that Lake Travis is a natural body of water and that water conditions including bacteria, pollutants, and environmental factors are outside the control of Texas Forever Charters, LLC. By entering the water I voluntarily assume all related risks.</p>

  <h3>4. Passenger Limits &amp; Off-Boat Liability</h3>
  <p>The vessel is licensed for <strong>20 guests plus crew (yacht)</strong> or <strong>13 guests plus crew (pontoon)</strong>. If I leave the vessel and board another boat while anchored, I do so at my own risk and release Texas Forever Charters, LLC from any liability during that time.</p>

  <h3>5. Vessel Operation</h3>
  <p>The vessel is operated by Daniel Kilpatrick and/or Dane Kilpatrick, certified Party Boat Operators. I agree to follow all captain and crew instructions at all times.</p>

  <h3>6. Indemnification &amp; Release</h3>
  <p>I agree to <strong>fully release, indemnify, and hold harmless</strong> Texas Forever Charters, LLC from all claims or liabilities including those arising from negligence or accident.</p>

  <h3>7. Damage</h3>
  <p>I will be financially responsible for any damage caused by my actions. A <strong>minimum $250 fee applies</strong> for damage. If damage exceeds $250, I agree to pay the full cost of repair or replacement.</p>

  <h3>8. Governing Law</h3>
  <p>This agreement is governed by the laws of the <strong>State of Texas</strong>. Disputes will be resolved in Travis County, Texas.</p>

  <h3>9. Minors</h3>
  <p>Minors must be accompanied by a parent or guardian who signs on their behalf. The guardian assumes full responsibility for the minor's actions and safety.</p>

  <h3>10. Electronic Signature</h3>
  <p>By typing my full legal name below, I agree that my electronic signature is the <strong>legally binding equivalent of my handwritten signature</strong>. I will not claim at any future time that my electronic signature is not legally binding or enforceable.</p>

  <h3>11. Media Release</h3>
  <p>I grant Texas Forever Charters, LLC the right to use my name, image, voice, and likeness in photos or videos taken during the charter for marketing purposes. If I do not consent, I will notify the captain before the charter begins.</p>
`;

// Format a timestamp as e.g. "May 15, 2026 at 2:34 PM CT" — robust against
// system timezone differences by always rendering in America/Chicago.
function formatSignedAtCT(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  if (isNaN(d)) return isoString;
  const datePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month:    'long',
    day:      'numeric',
    year:     'numeric',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour:     'numeric',
    minute:   '2-digit',
    hour12:   true,
  }).format(d);
  return datePart + ' at ' + timePart + ' CT';
}

function buildWaiverConfirmationEmail(w) {
  const fullName = ((w.signer_first_name || '') + ' ' + (w.signer_last_name || '')).trim() || 'Guest';
  const charterDate = w.charter_date ? formatDate(String(w.charter_date).slice(0, 10)) : 'TBD';
  const vesselName = w.vessel ? vesselLabel(w.vessel) : 'TBD';
  const signedAt = formatSignedAtCT(w.signed_at);

  let html = emailHeader();

  // Hero
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:28px;">&#9989;</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">Waiver Signed</div>' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.7;">' +
      'Thank you, ' + fullName + '. See you on the water.' +
    '</div></td></tr></table>';

  // Receipt details
  html += sectionBox('Signature Receipt', detailTable([
    ['Signer',      fullName],
    ['Charter Date', charterDate],
    ['Vessel',      vesselName],
    ['Signed At',   signedAt],
  ]));

  // Legal binding note
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#FFFFFF;padding:0 32px;border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB;">' +
    '<div style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:6px;padding:14px 18px;font-size:13px;color:#92400E;line-height:1.6;">' +
      '<strong>This waiver was electronically signed and is legally binding.</strong> ' +
      'Keep this email for your records.' +
    '</div>' +
    '</td></tr></table>';
  html += divider();

  // Full waiver text the signer agreed to
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#FFFFFF;padding:24px 32px;border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB;">' +
    '<div style="font-size:10px;font-weight:700;color:#C8102E;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;">' +
      'Waiver Agreement (Permanent Copy)' +
    '</div>' +
    '<div style="font-size:13px;color:#374151;line-height:1.7;">' +
      WAIVER_TEXT_V1_HTML +
    '</div>' +
    '</td></tr></table>';
  html += divider();

  // Contact CTA
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#FFFFFF;padding:24px 32px;text-align:center;' +
      'border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB;">' +
    '<div style="font-size:13px;color:#6B7280;line-height:1.7;margin-bottom:14px;">' +
      'Questions about your waiver or charter? We\'re here.' +
    '</div>' +
    '<a href="tel:+17373681669" style="display:inline-block;background:#C8102E;color:#FFFFFF;' +
      'font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
      'text-decoration:none;padding:13px 28px;border-radius:6px;">' +
      'Call (737) 368-1669' +
    '</a>' +
    '</td></tr></table>';
  html += divider();
  html += emailFooter();

  return emailWrapper(html);
}

async function sendWaiverConfirmationEmail(w) {
  if (!w || !w.signer_email) {
    console.log('[send-emails] sendWaiverConfirmationEmail: no signer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending waiver confirmation to:', w.signer_email, 'waiver_id:', w.id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [w.signer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'Your Signed Waiver — Texas Forever Charters',
    html:     buildWaiverConfirmationEmail(w),
  });
  console.log('[send-emails] Waiver confirmation sent OK. Resend id:', result.id);
  return result;
}

function buildWaiverLinkEmail(b) {
  const name = (b.full_name || '').split(' ')[0] || 'there';
  const link = waiverLinkFor(b.session_id);
  const portalUrl = portalUrlFor(b);
  /* Block-format portal sentence here (not inline-prose) because the
     surrounding markup uses separate <div> blocks for the URL display and
     the Questions line; inserting a bare-text fragment would land between
     blocks without its own spacing. Other templates use inline-prose
     concatenation because their portal mention extends a body sentence. */
  const portalBlock = portalUrl
    ? '<div style="margin-top:14px;font-size:14px;color:#374151;line-height:1.7;">You can also sign, share, and manage your charter from <a href="' + portalUrl + '" style="color:#1B2A6B;text-decoration:none;font-weight:700;">your booking portal</a>.</div>'
    : '';
  let html = emailHeader();

  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:28px;">📋</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">Waiver Link</div>' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.7;">' +
      'Share this with your group before your charter.' +
    '</div></td></tr></table>';

  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Hi ' + name + ',<br><br>' +
      'Please share the link below with everyone in your party. ' +
      '<strong>Each guest must sign individually before your charter date.</strong>' +
      '<div style="text-align:center;margin:18px 0 8px;">' +
        '<a href="' + link + '" style="display:inline-block;background:#1B2A6B;color:#FFFFFF;' +
          'font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
          'text-decoration:none;padding:14px 28px;border-radius:6px;">Sign the Waiver</a>' +
      '</div>' +
      '<div style="font-size:12px;color:#6B7280;text-align:center;word-break:break-all;">' + link + '</div>' +
      portalBlock +
      '<div style="margin-top:14px;">Questions? Call or text us at ' +
        '<a href="tel:+17373681669" style="color:#C8102E;text-decoration:none;font-weight:700;">(737) 368-1669</a>.' +
      '</div>' +
    '</div>');
  html += divider();
  if (b.date) { html += bookingDetailsBlock(b); html += divider(); }
  html += emailFooter();
  return emailWrapper(html);
}

async function sendWaiverLinkEmail(booking) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendWaiverLinkEmail: no customer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending waiver link to:', booking.customer_email, 'session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'Please Share This Waiver Link With Your Group — Texas Forever Charters',
    html:     buildWaiverLinkEmail(booking),
  });
  console.log('[send-emails] Waiver link email sent OK. Resend id:', result.id);
  return result;
}

/* ── Customer portal link ─────────────────────────────────────────────
   Admin-triggered email sending the customer their portal URL (the
   self-service page at /booking/<portal_token> with waiver status, day-of
   info, vessel amenities, etc.). Patterned after buildWaiverLinkEmail —
   shares emailHeader/Footer/Wrapper + sectionBox + bookingDetailsBlock.
   Customer-facing subject + body, so em-dashes are avoided per the
   project em-dash rule (period split, comma split, parens used instead). */
function buildPortalLinkEmail(b, portalUrl) {
  const name = (b.full_name || '').split(' ')[0] || 'there';
  let html = emailHeader();

  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:28px;">⚓</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">Your Charter Portal</div>' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.7;">' +
      'Everything you need for charter day in one place.' +
    '</div></td></tr></table>';

  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Hi ' + name + ',<br><br>' +
      'Your Texas Forever Charters portal is ready. It has your charter details, ' +
      'the waiver link to share with your group, where to go on charter day, ' +
      'what to bring, and the full list of policies and FAQs.' +
      '<div style="text-align:center;margin:18px 0 8px;">' +
        '<a href="' + portalUrl + '" style="display:inline-block;background:#C8102E;color:#FFFFFF;' +
          'font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
          'text-decoration:none;padding:14px 32px;border-radius:6px;">Open Your Portal</a>' +
      '</div>' +
      '<div style="font-size:12px;color:#6B7280;text-align:center;word-break:break-all;">' + portalUrl + '</div>' +
      '<div style="margin-top:18px;font-size:13px;color:#6B7280;">' +
        'Treat this link like a password. You can share it with your party, but please don\'t post it publicly.' +
      '</div>' +
      '<div style="margin-top:14px;">Questions? Call or text us at ' +
        '<a href="tel:+17373681669" style="color:#C8102E;text-decoration:none;font-weight:700;">(737) 368-1669</a>.' +
      '</div>' +
    '</div>');
  html += divider();
  if (b.date) { html += bookingDetailsBlock(b); html += divider(); }
  html += emailFooter();
  return emailWrapper(html);
}

async function sendPortalLinkEmail(booking, portalUrl) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendPortalLinkEmail: no customer_email — skipping');
    return null;
  }
  if (!portalUrl) {
    console.error('[send-emails] sendPortalLinkEmail: no portalUrl provided');
    throw new Error('portalUrl required');
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending portal link to:', booking.customer_email, 'session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'Your Texas Forever Charters Portal Is Ready',
    html:     buildPortalLinkEmail(booking, portalUrl),
  });
  console.log('[send-emails] Portal link email sent OK. Resend id:', result.id);
  return result;
}

/* ── Balance-paid confirmation ────────────────────────────────────────
   Customer-facing email fired after a successful portal Pay Balance Now
   flow (Phase 4 Commit 8 follow-up). Stripe also sends its own auto-
   receipt for the payment; this email is the TFC-branded version that
   restates the charter and provides the portal back-link.

   Green-tinted hero panel (#6EE7B7-family border) signals the "fully
   paid" lifecycle state, distinct from the navy-only hero used by
   portal-link/waiver-link emails which are neutral status messages. */
function buildBalancePaidEmail(b) {
  const name = (b.full_name || '').split(' ')[0] || 'there';
  /* In practice portal_token is always present by the time this email
     fires — balance payments require an existing booking row, and
     Phase 2.5 auto-gens portal_token at insert. portalCta omits cleanly
     if a legacy row somehow lacks one; broken-link fallback is worse
     than silent omission. Greeting + Questions/Reply contact line stay
     unconditional so the email still reads complete without the CTA. */
  const portalUrl = portalUrlFor(b);
  const portalCta = portalUrl
    ? '<div style="text-align:center;margin:18px 0 8px;">' +
        '<a href="' + portalUrl + '" style="display:inline-block;background:#C8102E;color:#FFFFFF;' +
          'font-size:14px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
          'text-decoration:none;padding:14px 32px;border-radius:6px;">Open Your Portal</a>' +
      '</div>' +
      '<div style="font-size:12px;color:#6B7280;text-align:center;word-break:break-all;">' + portalUrl + '</div>'
    : '';
  let html = emailHeader();

  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(110,231,183,0.35);border-right:1px solid rgba(110,231,183,0.35);">' +
    '<div style="font-size:28px;">✓</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">Balance Paid In Full</div>' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.7;">' +
      "You're all set for charter day." +
    '</div></td></tr></table>';

  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Hi ' + name + ',<br><br>' +
      'Your remaining balance has been received. Your charter is now fully paid. ' +
      'Stripe will send a separate payment receipt for your records.' +
      portalCta +
      '<div style="margin-top:18px;">Questions? Reply to this email or call ' +
        '<a href="tel:+17373681669" style="color:#C8102E;text-decoration:none;font-weight:700;">(737) 368-1669</a>.' +
      '</div>' +
    '</div>');
  html += divider();
  if (b.date) { html += bookingDetailsBlock(b); html += divider(); }
  html += emailFooter();
  return emailWrapper(html);
}

async function sendBalancePaidEmail(booking) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendBalancePaidEmail: no customer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending balance-paid email to:', booking.customer_email,
    'session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'Your Texas Forever Charters balance is paid',
    html:     buildBalancePaidEmail(booking),
  });
  console.log('[send-emails] Balance-paid email sent OK. Resend id:', result.id);
  return result;
}

/* ── Payment reminder emails ── */

function moneyDollars(n) {
  return formatMoneyDollars(n);
}

function firstNameOf(b) {
  return (b.full_name || '').split(' ')[0] || 'there';
}

function paymentLinkBlock(paymentLink) {
  if (!paymentLink) return '';
  return '<div style="text-align:center;margin:18px 0 6px;">' +
    '<a href="' + paymentLink + '" style="display:inline-block;background:#1B2A6B;color:#FFFFFF;' +
      'font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
      'text-decoration:none;padding:14px 28px;border-radius:6px;">Pay Balance Now</a>' +
    '</div>' +
    '<div style="font-size:12px;color:#6B7280;text-align:center;word-break:break-all;">' + paymentLink + '</div>';
}

function callCtaBlock(label) {
  return '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#FFFFFF;padding:24px 32px;text-align:center;' +
      'border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB;">' +
    '<a href="tel:+17373681669" style="display:inline-block;background:#C8102E;color:#FFFFFF;' +
      'font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
      'text-decoration:none;padding:13px 28px;border-radius:6px;">' +
      (label || 'Call (737) 368-1669') +
    '</a>' +
    '</td></tr></table>';
}

function buildFriendlyReminderEmail(b, paymentLink) {
  const amount = moneyDollars(b.remaining_balance);
  const portalUrl = portalUrlFor(b);
  const portalSentence = portalUrl
    ? ' You can manage your charter and pay your balance anytime at <a href="' + portalUrl + '" style="color:#1B2A6B;text-decoration:none;font-weight:700;">your booking portal</a>.'
    : '';
  let html = emailHeader();
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:28px;">&#128197;</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">Balance Due in 7 Days</div>' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.7;">' +
      'Just a friendly reminder ahead of your charter.' +
    '</div></td></tr></table>';
  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Hi ' + firstNameOf(b) + ', just a friendly reminder that your balance of <strong>' + amount + '</strong> ' +
      'for your <strong>' + vesselLabel(b.vessel) + '</strong> charter on <strong>' + formatDate(b.date) + '</strong> ' +
      'is due in <strong>7 days</strong>. Pay early and you\'re all set!' +
      portalSentence +
      paymentLinkBlock(paymentLink) +
    '</div>');
  html += divider();
  html += bookingDetailsBlock(b);
  html += divider();
  html += callCtaBlock('Questions? Call (737) 368-1669');
  html += divider();
  html += emailFooter();
  return emailWrapper(html);
}

function buildDueTodayEmail(b, paymentLink) {
  const amount = moneyDollars(b.remaining_balance);
  const portalUrl = portalUrlFor(b);
  const portalSentence = portalUrl
    ? ' You can pay and manage your charter from <a href="' + portalUrl + '" style="color:#1B2A6B;text-decoration:none;font-weight:700;">your booking portal</a>.'
    : '';
  let html = emailHeader();
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:28px;">&#9203;</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">Balance Due Today</div>' +
    '<div style="font-size:32px;font-weight:900;color:#D97706;font-family:Arial,sans-serif;margin-top:8px;">' +
      amount + '</div>' +
    '</td></tr></table>';
  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Hi ' + firstNameOf(b) + ', your balance of <strong>' + amount + '</strong> ' +
      'for your <strong>' + vesselLabel(b.vessel) + '</strong> charter on <strong>' + formatDate(b.date) + '</strong> ' +
      'is due <strong>today</strong>. Please complete your payment as soon as possible to keep your reservation.' +
      portalSentence +
      paymentLinkBlock(paymentLink) +
    '</div>');
  html += divider();
  html += bookingDetailsBlock(b);
  html += divider();
  html += callCtaBlock('Call (737) 368-1669');
  html += divider();
  html += emailFooter();
  return emailWrapper(html);
}

function buildOwnerAlertEmail(b) {
  const amount = moneyDollars(b.remaining_balance);
  let html = emailHeader();
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#C8102E;padding:18px 32px;text-align:center;">' +
    '<div style="font-size:16px;font-weight:900;color:#FFFFFF;letter-spacing:2px;text-transform:uppercase;">' +
      '&#9888;&#65039; Unpaid Balance Alert' +
    '</div></td></tr></table>';
  html += sectionBox('Summary',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      '<strong>' + (b.full_name || '—') + '</strong> has not paid their balance of <strong>' + amount + '</strong> ' +
      'for their <strong>' + vesselLabel(b.vessel) + '</strong> charter on <strong>' + formatDate(b.date) + '</strong>. ' +
      'Their charter is tomorrow\'s deadline.' +
    '</div>');
  html += divider();
  html += sectionBox('Customer Contact', detailTable([
    ['Full Name', b.full_name],
    ['Email',     b.customer_email || '—'],
    ['Phone',     b.phone || '—'],
  ]));
  html += divider();
  html += sectionBox('Booking', detailTable([
    ['Vessel',     vesselLabel(b.vessel)],
    ['Experience', b.experience],
    ['Date',       formatDate(b.date)],
    ['Start Time', b.time_slot],
    ['Balance',    amount],
  ]));
  html += divider();
  html += emailFooter();
  return emailWrapper(html);
}

function buildFinalNoticeEmail(b, paymentLink) {
  const amount = moneyDollars(b.remaining_balance);
  const portalUrl = portalUrlFor(b);
  const portalSentence = portalUrl
    ? ' If you\'d rather pay online than call, your balance is also payable from <a href="' + portalUrl + '" style="color:#1B2A6B;text-decoration:none;font-weight:700;">your booking portal</a>.'
    : '';
  let html = emailHeader();
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#C8102E;padding:32px;text-align:center;">' +
    '<div style="font-size:28px;">&#128680;</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">Final Notice — Past Due</div>' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.85);line-height:1.7;">' +
      'Pay within 24 hours to keep your charter.' +
    '</div></td></tr></table>';
  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Hi ' + firstNameOf(b) + ', your balance of <strong>' + amount + '</strong> ' +
      'for your <strong>' + vesselLabel(b.vessel) + '</strong> charter on <strong>' + formatDate(b.date) + '</strong> ' +
      'was due yesterday and has not been received. ' +
      '<strong>If payment is not received within 24 hours your charter will be cancelled and your deposit will be forfeited.</strong> ' +
      'Please call or text <a href="tel:+17373681669" style="color:#C8102E;text-decoration:none;font-weight:700;">(737) 368-1669</a> immediately.' +
      portalSentence +
      paymentLinkBlock(paymentLink) +
    '</div>');
  html += divider();
  html += bookingDetailsBlock(b);
  html += divider();
  html += callCtaBlock('Call (737) 368-1669 Now');
  html += divider();
  html += emailFooter();
  return emailWrapper(html);
}

async function sendFriendlyReminderEmail(booking, paymentLink) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendFriendlyReminderEmail: no customer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending friendly 21-day reminder to:', booking.customer_email, 'session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'Your Charter Balance is Due in 7 Days — Texas Forever Charters',
    html:     buildFriendlyReminderEmail(booking, paymentLink),
  });
  console.log('[send-emails] Friendly reminder sent OK. Resend id:', result.id);
  return result;
}

async function sendDueTodayEmail(booking, paymentLink) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendDueTodayEmail: no customer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending due-today 14-day reminder to:', booking.customer_email, 'session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'Your Charter Balance is Due Today — Texas Forever Charters',
    html:     buildDueTodayEmail(booking, paymentLink),
  });
  console.log('[send-emails] Due-today reminder sent OK. Resend id:', result.id);
  return result;
}

/* Internal-only alert fired by stripe-webhook when the $250 damage deposit
   pre-auth fails after the main charge succeeded. Customer sees the same
   confirmation flow as a healthy booking; this email is the only signal
   to the owner that the hold needs to be chased manually. */
async function sendDamageHoldFailedAlert(booking, errorMessage) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const subject = '⚠️ Damage hold FAILED — ' +
    (booking.charter_name || booking.full_name || 'Charter') +
    ' — ' + (booking.date || 'unknown date');

  const safeErr = String(errorMessage || '(no error message captured)')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const html = emailWrapper(
    emailHeader() +
    '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td style="background:#FFFFFF;padding:32px;border-left:4px solid #C8102E;">' +
        '<h2 style="font-family:Arial,sans-serif;color:#C8102E;margin:0 0 16px;font-size:20px;">⚠️ $250 Damage Hold Authorization Failed</h2>' +
        '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:0 0 16px;">' +
          'The customer charge succeeded, but the $250 damage deposit pre-authorization could NOT be created. ' +
          'The booking row was saved; <strong>damage_hold_status is <code>failed</code></strong> in the database. ' +
          'Follow up with the customer to capture a manual hold or accept the booking without one.' +
        '</p>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Booking Details</h3>' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#1F2937;">' +
          '<tr><td style="padding:4px 0;color:#6B7280;width:40%;">Customer</td><td style="padding:4px 0;font-weight:600;">' + (booking.full_name || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Email</td><td style="padding:4px 0;font-weight:600;">' + (booking.customer_email || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Phone</td><td style="padding:4px 0;font-weight:600;">' + (booking.phone || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Charter Date</td><td style="padding:4px 0;font-weight:600;">' + formatDate(booking.date) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Time Slot</td><td style="padding:4px 0;font-weight:600;">' + (booking.time_slot || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Vessel</td><td style="padding:4px 0;font-weight:600;">' + vesselLabel(booking.vessel) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Duration</td><td style="padding:4px 0;font-weight:600;">' + (booking.duration || '—') + ' hrs</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Stripe session</td><td style="padding:4px 0;font-weight:600;font-family:monospace;font-size:12px;">' + (booking.session_id || '—') + '</td></tr>' +
          (booking.payment_intent_id ? '<tr><td style="padding:4px 0;color:#6B7280;">Payment intent</td><td style="padding:4px 0;font-weight:600;font-family:monospace;font-size:12px;">' + booking.payment_intent_id + '</td></tr>' : '') +
        '</table>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Stripe Error</h3>' +
        '<div style="background:#FEF2F2;border:1px solid #FCA5A5;border-radius:6px;padding:12px;font-family:monospace;font-size:12px;color:#991B1B;line-height:1.5;">' +
          safeErr +
        '</div>' +
        '<p style="font-family:Arial,sans-serif;color:#6B7280;font-size:12px;margin-top:24px;">' +
          'Automated internal alert — customer was NOT notified. Open the admin panel to flag this booking for follow-up.' +
        '</p>' +
      '</td></tr>' +
    '</table>' +
    emailFooter()
  );

  console.log('[send-emails] Sending damage-hold failure alert to:', BUSINESS_EMAIL, 'session:', booking.session_id);
  const result = await postToResend({
    from:    FROM_EMAIL,
    to:      [BUSINESS_EMAIL],
    subject,
    html,
  });
  console.log('[send-emails] Damage-hold alert sent OK. Resend id:', result.id);
  return result;
}

/* Real-time owner alert for a high-value lead. Fired by:
     - api/capture-lead    when grand_total >= $500 and a lead is consented-captured at exit-intent
     - api/stripe-webhook  when a $500+ lead becomes 'abandoned_stripe' or 'payment_failed'
   `reason` is one of: 'captured', 'abandoned_stripe', 'payment_failed'.
   The lead row supplies everything else. */
async function sendHighValueLeadAlert(lead, reason) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  if (!lead) throw new Error('sendHighValueLeadAlert: lead required');

  const grandTotal = parseFloat(lead.grand_total || 0);
  const grandTotalStr = formatMoneyDollars(grandTotal);

  const reasonCopy = {
    captured:         { label: 'Captured at exit-intent (consented to follow-up)', color: '#1B2A6B', icon: '✋' },
    abandoned_stripe: { label: 'Reached Stripe but did NOT complete payment',      color: '#B45309', icon: '⚠️' },
    payment_failed:   { label: 'Card was DECLINED at Stripe',                       color: '#C8102E', icon: '❌' },
  }[reason] || { label: 'Lead lifecycle event: ' + reason, color: '#1B2A6B', icon: '💰' };

  const subject = '💰 High-value lead — ' + grandTotalStr + ' ' +
    vesselLabel(lead.vessel) + ' charter — ' + (lead.full_name || lead.customer_email || 'unknown');

  const phoneRow = lead.phone
    ? '<tr><td style="padding:4px 0;color:#6B7280;width:35%;">Phone</td><td style="padding:4px 0;font-weight:700;"><a href="tel:' + encodeURI(lead.phone) + '" style="color:#1B2A6B;text-decoration:none;">' + lead.phone + '</a></td></tr>'
    : '<tr><td style="padding:4px 0;color:#6B7280;width:35%;">Phone</td><td style="padding:4px 0;color:#9CA3AF;font-style:italic;">not provided</td></tr>';

  const html = emailWrapper(
    emailHeader() +
    '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td style="background:#FFFFFF;padding:32px;border-left:4px solid ' + reasonCopy.color + ';">' +
        '<h2 style="font-family:Arial,sans-serif;color:' + reasonCopy.color + ';margin:0 0 8px;font-size:22px;">' +
          reasonCopy.icon + ' High-value lead — ' + grandTotalStr +
        '</h2>' +
        '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:0 0 20px;">' +
          '<strong>What happened:</strong> ' + reasonCopy.label +
        '</p>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Customer</h3>' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:14px;color:#1F2937;">' +
          '<tr><td style="padding:4px 0;color:#6B7280;width:35%;">Name</td><td style="padding:4px 0;font-weight:700;">' + (lead.full_name || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;width:35%;">Email</td><td style="padding:4px 0;font-weight:700;"><a href="mailto:' + (lead.customer_email || '') + '" style="color:#1B2A6B;text-decoration:none;">' + (lead.customer_email || '—') + '</a></td></tr>' +
          phoneRow +
        '</table>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Charter</h3>' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:14px;color:#1F2937;">' +
          '<tr><td style="padding:4px 0;color:#6B7280;width:35%;">Vessel</td><td style="padding:4px 0;font-weight:600;">' + vesselLabel(lead.vessel) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Experience</td><td style="padding:4px 0;font-weight:600;">' + (lead.experience || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Date</td><td style="padding:4px 0;font-weight:600;">' + formatDate(lead.date) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Time</td><td style="padding:4px 0;font-weight:600;">' + (lead.time_slot || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Duration</td><td style="padding:4px 0;font-weight:600;">' + (lead.duration || '—') + ' hrs</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Party size</td><td style="padding:4px 0;font-weight:600;">' + (lead.party_size || '—') + '</td></tr>' +
        '</table>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Pricing</h3>' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:14px;color:#1F2937;">' +
          '<tr><td style="padding:4px 0;color:#6B7280;width:35%;">Grand total</td><td style="padding:4px 0;font-weight:800;color:' + reasonCopy.color + ';font-size:16px;">' + grandTotalStr + '</td></tr>' +
          (lead.deposit_amount ? '<tr><td style="padding:4px 0;color:#6B7280;">Deposit (10%)</td><td style="padding:4px 0;font-weight:600;">' + formatMoneyDollars(lead.deposit_amount) + '</td></tr>' : '') +
          (lead.payment_type ? '<tr><td style="padding:4px 0;color:#6B7280;">Payment type</td><td style="padding:4px 0;font-weight:600;">' + lead.payment_type + '</td></tr>' : '') +
        '</table>' +
        '<p style="font-family:Arial,sans-serif;color:#6B7280;font-size:12px;margin-top:24px;">' +
          'Captured at: ' + (lead.captured_at || new Date().toISOString()) +
          (lead.stripe_session_id ? '<br>Stripe session: <span style="font-family:monospace;">' + lead.stripe_session_id + '</span>' : '') +
        '</p>' +
        '<div style="margin-top:24px;text-align:center;">' +
          (lead.phone ? '<a href="tel:' + encodeURI(lead.phone) + '" style="display:inline-block;background:#C8102E;color:#FFFFFF;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:700;margin:4px;">📞 Call ' + lead.phone + '</a>' : '') +
          '<a href="mailto:' + (lead.customer_email || '') + '?subject=Texas%20Forever%20Charters%20-%20Following%20up%20on%20your%20charter%20inquiry" style="display:inline-block;background:#1B2A6B;color:#FFFFFF;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:700;margin:4px;">✉ Email ' + (lead.customer_email || '') + '</a>' +
        '</div>' +
      '</td></tr>' +
    '</table>' +
    emailFooter()
  );

  console.log('[send-emails] Sending high-value lead alert to:', BUSINESS_EMAIL,
    '| reason:', reason, '| grand_total:', grandTotalStr, '| lead_id:', lead.id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [BUSINESS_EMAIL],
    reply_to: lead.customer_email || BUSINESS_EMAIL,
    subject,
    html,
  });
  console.log('[send-emails] High-value lead alert sent OK. Resend id:', result.id);
  return result;
}

/* Daily digest of recent leads, fired by cron-reminders at 9am CT. Caller
   passes the already-grouped object so this function stays template-only:
     { captured: [...], abandoned_stripe: [...], payment_failed: [...], converted: [...] }
   If every bucket is empty the cron should skip calling this entirely —
   we don't send empty digests. */
async function sendDailyLeadDigest(grouped, opts) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  grouped = grouped || {};
  opts = opts || {};

  const buckets = {
    captured:         grouped.captured         || [],
    abandoned_stripe: grouped.abandoned_stripe || [],
    payment_failed:   grouped.payment_failed   || [],
    converted:        grouped.converted        || [],
  };
  const followUpList = []
    .concat(buckets.captured, buckets.abandoned_stripe, buckets.payment_failed)
    .filter(l => !l.contacted_at)
    .sort((a, b) => parseFloat(b.grand_total || 0) - parseFloat(a.grand_total || 0));

  const total = buckets.captured.length + buckets.abandoned_stripe.length +
                buckets.payment_failed.length + buckets.converted.length;

  const dateStr = opts.dateLabel || new Date().toISOString().slice(0, 10);
  const subject = '📊 Daily Lead Digest — ' + dateStr + ' — ' + total + ' total lead' + (total !== 1 ? 's' : '');

  function timeAgo(iso) {
    if (!iso) return '—';
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0 || !isFinite(ms)) return '—';
    const mins = Math.round(ms / 60000);
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    return Math.round(hrs / 24) + ' day' + (Math.round(hrs / 24) !== 1 ? 's' : '') + ' ago';
  }

  function statusLabel(s) {
    return ({
      captured:         'Captured at exit-intent',
      abandoned_stripe: 'Abandoned Stripe',
      payment_failed:   'Payment failed',
      converted:        'Converted to booking',
      contacted:        'Already contacted',
    })[s] || s;
  }

  const summaryRows =
    '<li style="margin:4px 0;"><strong>' + buckets.captured.length         + '</strong> captured at exit-intent</li>' +
    '<li style="margin:4px 0;"><strong>' + buckets.abandoned_stripe.length + '</strong> abandoned Stripe</li>' +
    '<li style="margin:4px 0;"><strong>' + buckets.payment_failed.length   + '</strong> payment failed</li>' +
    '<li style="margin:4px 0;"><strong>' + buckets.converted.length        + '</strong> converted to bookings</li>';

  /* 7-day bounce-reason breakdown. Emitted only if the cron passed in
     bounceReasonCounts AND there's at least one non-zero entry. Omit
     reasons with 0 count. 'untagged' is always shown last if > 0 so
     the admin can see how many leads still need tagging. */
  const BOUNCE_LABELS = {
    price:      'price',
    dates:      'dates',
    group:      'group',
    distracted: 'distracted',
    comparing:  'comparing',
    info:       'info',
    other:      'other',
    untagged:   'not tagged',
  };
  const BOUNCE_ORDER = ['price', 'dates', 'group', 'distracted', 'comparing', 'info', 'other', 'untagged'];
  let bounceSectionHtml = '';
  const bounceCounts = opts.bounceReasonCounts || null;
  if (bounceCounts && Object.values(bounceCounts).some(n => n > 0)) {
    const rows = BOUNCE_ORDER
      .filter(k => (bounceCounts[k] || 0) > 0)
      .map(k => '<li style="margin:4px 0;"><strong>' + bounceCounts[k] + '</strong> ' + BOUNCE_LABELS[k] + '</li>')
      .join('');
    bounceSectionHtml =
      '<hr style="border:none;border-top:1px solid #E5E7EB;margin:20px 0;">' +
      '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:16px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Bounce reasons this week</h3>' +
      '<ul style="font-family:Arial,sans-serif;font-size:14px;color:#1F2937;line-height:1.6;margin:0 0 16px;padding-left:20px;">' +
        rows +
      '</ul>';
  }

  /* 7-day contact-outcome breakdown. Only included when at least one
     lead in the window has a logged outcome. Same omit-if-0 + ordered-
     list pattern as the bounce-reason section. */
  const OUTCOME_LABELS = {
    booked:      'booked',
    maybe:       'following up',
    quoted:      'quoted',
    hard_no:     'declined',
    no_response: 'unreachable',
    other:       'other',
  };
  const OUTCOME_ORDER = ['booked', 'maybe', 'quoted', 'hard_no', 'no_response', 'other'];
  let outcomeSectionHtml = '';
  const outcomeCounts = opts.outcomeCounts || null;
  if (outcomeCounts && Object.values(outcomeCounts).some(n => n > 0)) {
    const rows = OUTCOME_ORDER
      .filter(k => (outcomeCounts[k] || 0) > 0)
      .map(k => '<li style="margin:4px 0;"><strong>' + outcomeCounts[k] + '</strong> ' + OUTCOME_LABELS[k] + '</li>')
      .join('');
    outcomeSectionHtml =
      '<hr style="border:none;border-top:1px solid #E5E7EB;margin:20px 0;">' +
      '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:16px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Contact outcomes this week</h3>' +
      '<ul style="font-family:Arial,sans-serif;font-size:14px;color:#1F2937;line-height:1.6;margin:0 0 16px;padding-left:20px;">' +
        rows +
      '</ul>';
  }

  const adminUrl = SITE_BASE + '/admin.html#leads';

  let followUpHtml;
  if (followUpList.length === 0) {
    followUpHtml = '<p style="font-family:Arial,sans-serif;color:#6B7280;font-style:italic;font-size:14px;">' +
      'No outstanding leads to follow up on — every lead is either converted or already contacted. Nice work!' +
      '</p>';
  } else {
    followUpHtml = followUpList.map(function (l) {
      const total = parseFloat(l.grand_total || 0);
      const totalStr = formatMoneyDollars(total);
      const phoneCell = l.phone
        ? '<a href="tel:' + encodeURI(l.phone) + '" style="color:#1B2A6B;text-decoration:none;font-weight:700;">' + l.phone + '</a>'
        : '<span style="color:#9CA3AF;font-style:italic;">not provided</span>';
      const accentColor = total >= 500 ? '#C8102E' : '#1B2A6B';
      return '<div style="background:#FFFFFF;border-left:4px solid ' + accentColor + ';border:1px solid #E5E7EB;border-radius:6px;padding:14px 16px;margin:10px 0;font-family:Arial,sans-serif;font-size:13px;color:#1F2937;line-height:1.5;">' +
          '<div style="font-size:15px;font-weight:800;color:#1B2A6B;margin-bottom:6px;">' +
            (l.full_name || '(no name)') +
            '<span style="float:right;color:' + accentColor + ';">' + totalStr + '</span>' +
          '</div>' +
          '<div style="margin:2px 0;"><span style="color:#6B7280;">Email:</span> <a href="mailto:' + (l.customer_email || '') + '" style="color:#1B2A6B;text-decoration:none;font-weight:600;">' + (l.customer_email || '—') + '</a></div>' +
          '<div style="margin:2px 0;"><span style="color:#6B7280;">Phone:</span> ' + phoneCell + '</div>' +
          '<div style="margin:2px 0;"><span style="color:#6B7280;">Charter:</span> ' + vesselLabel(l.vessel) + ' &middot; ' + (l.experience || '—') + ' &middot; ' + (l.duration || '—') + 'hr &middot; ' + formatDate(l.date) + ' @ ' + (l.time_slot || '—') + '</div>' +
          '<div style="margin:2px 0;"><span style="color:#6B7280;">Status:</span> ' + statusLabel(l.status) + ' &middot; <span style="color:#6B7280;">Captured</span> ' + timeAgo(l.captured_at) + '</div>' +
        '</div>';
    }).join('');
  }

  const html = emailWrapper(
    emailHeader() +
    '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td style="background:#FFFFFF;padding:32px;">' +
        '<h2 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:0 0 8px;font-size:22px;">📊 Daily Lead Digest</h2>' +
        '<div style="color:#6B7280;font-size:13px;margin-bottom:18px;">' + dateStr + ' &middot; last 24 hours</div>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:16px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Yesterday\'s Activity</h3>' +
        '<ul style="font-family:Arial,sans-serif;font-size:14px;color:#1F2937;line-height:1.6;margin:0 0 16px;padding-left:20px;">' +
          summaryRows +
        '</ul>' +
        bounceSectionHtml +
        outcomeSectionHtml +
        '<hr style="border:none;border-top:1px solid #E5E7EB;margin:20px 0;">' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:16px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Leads to Follow Up (sorted by total, $)</h3>' +
        followUpHtml +
        '<div style="text-align:center;margin:24px 0 8px;">' +
          '<a href="' + adminUrl + '" style="display:inline-block;background:#1B2A6B;color:#FFFFFF;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:700;">Open Admin → Leads</a>' +
        '</div>' +
        '<p style="font-family:Arial,sans-serif;color:#9CA3AF;font-size:11px;margin-top:24px;text-align:center;">' +
          'Sent automatically by the daily cron. Already-contacted and converted leads are omitted from the follow-up list above.' +
        '</p>' +
      '</td></tr>' +
    '</table>' +
    emailFooter()
  );

  console.log('[send-emails] Sending daily lead digest to:', BUSINESS_EMAIL, '| total:', total, '| to_follow_up:', followUpList.length);
  const result = await postToResend({
    from:    FROM_EMAIL,
    to:      [BUSINESS_EMAIL],
    subject,
    html,
  });
  console.log('[send-emails] Daily lead digest sent OK. Resend id:', result.id);
  return result;
}

/* Customer-facing follow-up email sent when the $250 damage deposit hold
   fails to authorize at booking time. Fires AFTER the standard confirmation
   email so the customer first sees that their charter is confirmed, then
   gets this heads-up as a separate message. Tone is reassuring — the
   charter is fine; the hold is an operational detail to handle on charter
   day or via phone update beforehand. */
async function sendDamageHoldFailedCustomerNotice(data) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  if (!data || !data.customer_email) {
    console.log('[send-emails] sendDamageHoldFailedCustomerNotice: no customer_email — skipping');
    return null;
  }

  const firstName = (data.full_name && typeof data.full_name === 'string')
    ? data.full_name.split(' ')[0]
    : 'there';

  const subject = 'Heads up: $250 security hold needs action — ' +
    (data.charter_name || 'Your Charter');

  /* Portal mention as a block element appended at the end of the body. This
     template is inline (no separate build* function) and the body is a
     sequence of <p> blocks, so we follow that pattern. portalUrlFor returns
     null when portal_token is missing — block omitted entirely. */
  const portalUrl = portalUrlFor(data);
  const portalBlock = portalUrl
    ? '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:0 0 16px;">' +
        'Your charter details, the waiver link, and dock directions are all available in ' +
        '<a href="' + portalUrl + '" style="color:#1B2A6B;font-weight:700;text-decoration:none;">your booking portal</a>.' +
      '</p>'
    : '';

  const html = emailWrapper(
    emailHeader() +
    '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td style="background:#FFFFFF;padding:32px;">' +
        '<h2 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:0 0 16px;font-size:22px;">' +
          'Your charter is confirmed — one small detail' +
        '</h2>' +
        '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:0 0 16px;">' +
          'Hi ' + firstName + ',' +
        '</p>' +
        '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:0 0 16px;">' +
          'Your charter on <strong>' + formatDate(data.date) + '</strong> is officially on the books — thank you! ' +
          'See the confirmation email we just sent for the full booking details.' +
        '</p>' +
        '<div style="background:#FEF3C7;border:1px solid #F59E0B;border-radius:8px;padding:16px 18px;margin:20px 0;font-family:Arial,sans-serif;color:#1F2937;font-size:14px;line-height:1.6;">' +
          '<strong style="color:#92400E;">One thing to flag:</strong> we weren\'t able to authorize the standard ' +
          '<strong>$250 refundable damage deposit hold</strong> on the card you used at checkout. ' +
          'This is a normal pre-authorization we place on every charter — it\'s NOT an additional charge, ' +
          'and it\'s released within 48 hours after your charter if there\'s no damage.' +
        '</div>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">What this means for you</h3>' +
        '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:0 0 12px;">' +
          'Please be prepared to provide an alternate payment method for the $250 security hold on the day of your charter. ' +
          'Your captain will set it up before departure — we accept all major cards.' +
        '</p>' +
        '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:0 0 16px;">' +
          'If you\'d rather sort it out ahead of time, just call or text us at ' +
          '<a href="tel:+17373681669" style="color:#1B2A6B;font-weight:700;text-decoration:none;">(737) 368-1669</a> ' +
          'and we\'ll send you a secure link to update your payment method.' +
        '</p>' +
        portalBlock +
        '<p style="font-family:Arial,sans-serif;color:#6B7280;font-size:13px;line-height:1.6;margin:28px 0 0;">' +
          'Looking forward to having you on the water — we\'ll see you soon.' +
          '<br><br>' +
          '— The Texas Forever Charters team' +
        '</p>' +
      '</td></tr>' +
    '</table>' +
    emailFooter()
  );

  console.log('[send-emails] Sending damage-hold customer notice to:', data.customer_email, 'session:', data.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [data.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject,
    html,
  });
  console.log('[send-emails] Damage-hold customer notice sent OK. Resend id:', result.id);
  return result;
}

/* Owner alert fired by the webhook when Stripe sends charge.refunded for a
   refund that wasn't originated by the admin panel — i.e., the owner issued
   the refund directly in the Stripe dashboard. The webhook has already
   reconciled refund_amount/refunded_at/status into Supabase by the time this
   fires; the email is purely a heads-up so money movement isn't invisible. */
async function sendStripeRefundReconciledAlert(booking, refundedAmountDollars, isFull) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');

  const amountStr = formatMoneyDollars(refundedAmountDollars);
  const refundType = isFull ? 'FULL refund' : 'PARTIAL refund';
  const subject = '💰 Stripe-side refund reconciled — ' +
    (booking.charter_name || booking.full_name || 'Charter') +
    ' — ' + (booking.date || 'unknown date');

  const html = emailWrapper(
    emailHeader() +
    '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td style="background:#FFFFFF;padding:32px;border-left:4px solid #F59E0B;">' +
        '<h2 style="font-family:Arial,sans-serif;color:#B45309;margin:0 0 16px;font-size:20px;">💰 Refund Reconciled From Stripe Dashboard</h2>' +
        '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:0 0 16px;">' +
          'A <strong>' + refundType + '</strong> of <strong>' + amountStr + '</strong> was issued through the Stripe dashboard ' +
          '(not the admin panel). Supabase has been updated automatically so admin and reporting reflect the refund.' +
          (isFull ? ' The booking status was set to <strong>cancelled</strong>.' : ' Booking status is unchanged (partial refund).') +
        '</p>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Booking Details</h3>' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#1F2937;">' +
          '<tr><td style="padding:4px 0;color:#6B7280;width:40%;">Customer</td><td style="padding:4px 0;font-weight:600;">' + (booking.full_name || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Email</td><td style="padding:4px 0;font-weight:600;">' + (booking.customer_email || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Charter Date</td><td style="padding:4px 0;font-weight:600;">' + formatDate(booking.date) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Time Slot</td><td style="padding:4px 0;font-weight:600;">' + (booking.time_slot || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Vessel</td><td style="padding:4px 0;font-weight:600;">' + vesselLabel(booking.vessel) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Refund Amount</td><td style="padding:4px 0;font-weight:700;color:#B45309;">' + amountStr + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Refund Type</td><td style="padding:4px 0;font-weight:600;">' + refundType + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Stripe session</td><td style="padding:4px 0;font-weight:600;font-family:monospace;font-size:12px;">' + (booking.session_id || '—') + '</td></tr>' +
        '</table>' +
        '<p style="font-family:Arial,sans-serif;color:#6B7280;font-size:12px;margin-top:24px;">' +
          'No customer-facing email was sent — Stripe already emails its own refund receipt from the dashboard. ' +
          'This alert is just to keep you in the loop about money movement that originated outside the admin panel.' +
        '</p>' +
      '</td></tr>' +
    '</table>' +
    emailFooter()
  );

  console.log('[send-emails] Sending Stripe-refund reconciled alert to:', BUSINESS_EMAIL, 'session:', booking.session_id);
  const result = await postToResend({
    from:    FROM_EMAIL,
    to:      [BUSINESS_EMAIL],
    subject,
    html,
  });
  console.log('[send-emails] Stripe-refund alert sent OK. Resend id:', result.id);
  return result;
}

/* URGENT owner alert fired by the webhook on charge.dispute.created. Stripe
   holds the funds and gives a response window (typically 7-21 days). The
   email surfaces the deadline (converted to Central Time), reason, dispute
   amount, and a deep link to the Stripe dispute. The booking row is updated
   separately by the webhook with dispute_id/status/amount/reason/disputed_at. */
async function sendChargebackAlert(booking, dispute) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');

  const amountFmt = formatMoney(dispute.amount || 0); // cents-input
  const subject = '🚨 CHARGEBACK ALERT — ' +
    (booking.charter_name || booking.full_name || 'Charter') +
    ' — ' + (booking.date || 'unknown date') +
    ' — ' + amountFmt;

  /* Stripe sends evidence_details.due_by as a Unix timestamp (seconds).
     Convert to a readable Central Time deadline string. */
  let deadlineStr = '(unknown — check Stripe dashboard)';
  const dueBy = dispute.evidence_details && dispute.evidence_details.due_by;
  if (dueBy) {
    const d = new Date(dueBy * 1000);
    deadlineStr = d.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long',
      year:    'numeric',
      month:   'long',
      day:     'numeric',
      hour:    'numeric',
      minute:  '2-digit',
      timeZoneName: 'short',
    });
  }

  const dashboardUrl = 'https://dashboard.stripe.com/disputes/' + dispute.id;

  const html = emailWrapper(
    emailHeader() +
    '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td style="background:#FFFFFF;padding:32px;border-left:4px solid #C8102E;">' +
        '<h2 style="font-family:Arial,sans-serif;color:#C8102E;margin:0 0 8px;font-size:22px;">🚨 CHARGEBACK FILED — IMMEDIATE ACTION REQUIRED</h2>' +
        '<div style="background:#FEF2F2;border:2px solid #C8102E;border-radius:8px;padding:16px;margin:16px 0;font-family:Arial,sans-serif;color:#1F2937;font-size:14px;line-height:1.5;">' +
          '<strong style="color:#C8102E;">Respond to this dispute in the Stripe dashboard before<br>' + deadlineStr + '</strong><br>' +
          'or you forfeit the funds automatically.' +
        '</div>' +
        '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:16px 0;">' +
          '<a href="' + dashboardUrl + '" style="display:inline-block;background:#1B2A6B;color:#FFFFFF;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:700;">→ Open dispute in Stripe dashboard</a>' +
        '</p>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Dispute Details</h3>' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#1F2937;">' +
          '<tr><td style="padding:4px 0;color:#6B7280;width:40%;">Amount Disputed</td><td style="padding:4px 0;font-weight:700;color:#C8102E;font-size:15px;">' + amountFmt + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Reason</td><td style="padding:4px 0;font-weight:600;">' + (dispute.reason || '(unknown)') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Status</td><td style="padding:4px 0;font-weight:600;">' + (dispute.status || '(unknown)') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Response Deadline</td><td style="padding:4px 0;font-weight:700;color:#C8102E;">' + deadlineStr + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Dispute ID</td><td style="padding:4px 0;font-weight:600;font-family:monospace;font-size:12px;">' + dispute.id + '</td></tr>' +
        '</table>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Booking Details</h3>' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#1F2937;">' +
          '<tr><td style="padding:4px 0;color:#6B7280;width:40%;">Customer</td><td style="padding:4px 0;font-weight:600;">' + (booking.full_name || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Email</td><td style="padding:4px 0;font-weight:600;">' + (booking.customer_email || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Phone</td><td style="padding:4px 0;font-weight:600;">' + (booking.phone || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Charter Date</td><td style="padding:4px 0;font-weight:600;">' + formatDate(booking.date) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Time Slot</td><td style="padding:4px 0;font-weight:600;">' + (booking.time_slot || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Vessel</td><td style="padding:4px 0;font-weight:600;">' + vesselLabel(booking.vessel) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Stripe session</td><td style="padding:4px 0;font-weight:600;font-family:monospace;font-size:12px;">' + (booking.session_id || '—') + '</td></tr>' +
          (booking.payment_intent_id ? '<tr><td style="padding:4px 0;color:#6B7280;">Payment intent</td><td style="padding:4px 0;font-weight:600;font-family:monospace;font-size:12px;">' + booking.payment_intent_id + '</td></tr>' : '') +
        '</table>' +
        '<p style="font-family:Arial,sans-serif;color:#6B7280;font-size:12px;margin-top:24px;">' +
          'Stripe is holding the disputed funds. Submit your evidence (charter agreement, waiver signature, customer communications) ' +
          'in the Stripe dashboard before the deadline above. The booking row is unchanged — admin shows a "⚠️ CHARGEBACK" badge.' +
        '</p>' +
      '</td></tr>' +
    '</table>' +
    emailFooter()
  );

  console.log('[send-emails] Sending chargeback alert to:', BUSINESS_EMAIL, 'dispute:', dispute.id);
  const result = await postToResend({
    from:    FROM_EMAIL,
    to:      [BUSINESS_EMAIL],
    subject,
    html,
  });
  console.log('[send-emails] Chargeback alert sent OK. Resend id:', result.id);
  return result;
}

/* Owner alert fired by the cron retry pass after the 5th consecutive failure
   to deliver a customer confirmation email. Sent once per booking (cron
   tracks via reminders_sent.confirmation_perm_fail_alerted). The booking row
   itself is intact — only the email channel is broken. */
async function sendConfirmationEmailPermanentFailureAlert(booking) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const subject = '🔴 Confirmation email PERMANENTLY FAILED — ' +
    (booking.charter_name || booking.full_name || 'Charter') +
    ' — ' + (booking.date || 'unknown date');

  const html = emailWrapper(
    emailHeader() +
    '<table width="100%" cellpadding="0" cellspacing="0" border="0">' +
      '<tr><td style="background:#FFFFFF;padding:32px;border-left:4px solid #C8102E;">' +
        '<h2 style="font-family:Arial,sans-serif;color:#C8102E;margin:0 0 16px;font-size:20px;">🔴 Customer Confirmation Email Permanently Failed</h2>' +
        '<p style="font-family:Arial,sans-serif;color:#1F2937;line-height:1.6;font-size:14px;margin:0 0 16px;">' +
          'The cron retry has tried to deliver this customer\'s confirmation email <strong>5 times</strong> and every attempt failed. ' +
          'No further automated retries will run for this booking. ' +
          'Reach the customer through another channel — text, phone, or a different email address — and use the admin panel to re-trigger a send after correcting the address.' +
        '</p>' +
        '<h3 style="font-family:Arial,sans-serif;color:#1B2A6B;margin:24px 0 8px;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Booking Details</h3>' +
        '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;color:#1F2937;">' +
          '<tr><td style="padding:4px 0;color:#6B7280;width:40%;">Customer</td><td style="padding:4px 0;font-weight:600;">' + (booking.full_name || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Email on file</td><td style="padding:4px 0;font-weight:600;">' + (booking.customer_email || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Phone</td><td style="padding:4px 0;font-weight:600;">' + (booking.phone || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Charter Date</td><td style="padding:4px 0;font-weight:600;">' + formatDate(booking.date) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Time Slot</td><td style="padding:4px 0;font-weight:600;">' + (booking.time_slot || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Vessel</td><td style="padding:4px 0;font-weight:600;">' + vesselLabel(booking.vessel) + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Duration</td><td style="padding:4px 0;font-weight:600;">' + (booking.duration || '—') + ' hrs</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Party Size</td><td style="padding:4px 0;font-weight:600;">' + (booking.party_size || '—') + '</td></tr>' +
          '<tr><td style="padding:4px 0;color:#6B7280;">Stripe session</td><td style="padding:4px 0;font-weight:600;font-family:monospace;font-size:12px;">' + (booking.session_id || '—') + '</td></tr>' +
        '</table>' +
        '<p style="font-family:Arial,sans-serif;color:#6B7280;font-size:12px;margin-top:24px;">' +
          'Automated internal alert — sent ONCE per booking after the 5th failed retry. ' +
          'The booking row, payment, and damage hold are unaffected; only email delivery has failed.' +
        '</p>' +
      '</td></tr>' +
    '</table>' +
    emailFooter()
  );

  console.log('[send-emails] Sending confirmation perm-fail alert to:', BUSINESS_EMAIL, 'session:', booking.session_id);
  const result = await postToResend({
    from:    FROM_EMAIL,
    to:      [BUSINESS_EMAIL],
    subject,
    html,
  });
  console.log('[send-emails] Confirmation perm-fail alert sent OK. Resend id:', result.id);
  return result;
}

async function sendOwnerAlertEmail(booking) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  const subject = '⚠ Unpaid Balance Alert — ' + (booking.full_name || 'Customer') +
    ' — Charter ' + formatDate(booking.date);
  console.log('[send-emails] Sending owner alert to:', BUSINESS_EMAIL, 'session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [BUSINESS_EMAIL],
    reply_to: booking.customer_email || BUSINESS_EMAIL,
    subject,
    html:     buildOwnerAlertEmail(booking),
  });
  console.log('[send-emails] Owner alert sent OK. Resend id:', result.id);
  return result;
}

async function sendFinalNoticeEmail(booking, paymentLink) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendFinalNoticeEmail: no customer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending final notice 12-day reminder to:', booking.customer_email, 'session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'URGENT: Final Notice — Charter Balance Past Due — Texas Forever Charters',
    html:     buildFinalNoticeEmail(booking, paymentLink),
  });
  console.log('[send-emails] Final notice sent OK. Resend id:', result.id);
  return result;
}

/* ── Post-charter review request ── */

// Placeholder Google review URL — swap with the real Google Business review
// link once it's available. Kept as one constant so it's easy to change.
const GOOGLE_REVIEW_URL = process.env.GOOGLE_REVIEW_URL || 'https://g.page/r/GOOGLE_REVIEW_LINK/review';

function feedbackUrl(session_id) {
  const base = SITE_BASE + '/feedback.html';
  return session_id ? base + '?booking=' + encodeURIComponent(session_id) : base;
}

function buildReviewRequestEmail(b) {
  const name = firstNameOf(b);
  const privateLink = feedbackUrl(b.session_id);
  /* Referential portal mention — past-charter, so the portal is now a
     historical record rather than an action surface. Subtle inline link in
     the sign-off area; null guard skips entirely for legacy bookings. */
  const portalUrl = portalUrlFor(b);
  const portalSentence = portalUrl
    ? ' Your charter details remain available in <a href="' + portalUrl + '" style="color:#1B2A6B;text-decoration:none;font-weight:700;">your booking portal</a> as a record of your day on the water.'
    : '';

  let html = emailHeader();

  // Hero
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#0A1030;padding:32px;text-align:center;' +
      'border-left:1px solid rgba(200,16,46,0.25);border-right:1px solid rgba(200,16,46,0.25);">' +
    '<div style="font-size:32px;">&#11088;</div>' +
    '<div style="font-size:24px;font-weight:900;color:#FFFFFF;letter-spacing:2px;' +
      'text-transform:uppercase;margin:10px 0 8px;font-family:Arial,sans-serif;">How Was Your Charter?</div>' +
    '<div style="font-size:14px;color:rgba(255,255,255,0.7);line-height:1.7;">' +
      'We\'d love to hear about your day on Lake Travis.' +
    '</div></td></tr></table>';

  // Message
  html += sectionBox('Message',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Hi ' + name + ',<br><br>' +
      'Thank you for choosing Texas Forever Charters! We hope you had an amazing time on Lake Travis yesterday.<br><br>' +
      'We\'d love to hear about your experience. How would you rate your charter?' +
    '</div>');
  html += divider();

  // Two CTAs side-by-side (collapse on narrow clients)
  html += '<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>' +
    '<td style="background:#FFFFFF;padding:24px 32px;border-left:1px solid #E5E7EB;border-right:1px solid #E5E7EB;">' +

    // Google review CTA
    '<div style="text-align:center;margin-bottom:20px;">' +
      '<div style="font-size:22px;color:#F59E0B;letter-spacing:2px;margin-bottom:10px;">' +
        '&#11088;&#11088;&#11088;&#11088;&#11088;' +
      '</div>' +
      '<a href="' + GOOGLE_REVIEW_URL + '" style="display:inline-block;background:#16A34A;color:#FFFFFF;' +
        'font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
        'text-decoration:none;padding:14px 28px;border-radius:6px;">Leave a 5-Star Google Review</a>' +
    '</div>' +

    // Divider line "or"
    '<div style="text-align:center;margin:16px 0;">' +
      '<span style="font-size:11px;font-weight:700;color:#9CA3AF;letter-spacing:3px;text-transform:uppercase;">or</span>' +
    '</div>' +

    // Private feedback CTA
    '<div style="text-align:center;">' +
      '<div style="font-size:22px;margin-bottom:10px;">&#128533;</div>' +
      '<a href="' + privateLink + '" style="display:inline-block;background:#1B2A6B;color:#FFFFFF;' +
        'font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;' +
        'text-decoration:none;padding:14px 28px;border-radius:6px;">Share Private Feedback</a>' +
      '<div style="font-size:12px;color:#6B7280;margin-top:8px;">Goes directly to us &mdash; not posted publicly.</div>' +
    '</div>' +

    '</td></tr></table>';

  html += divider();

  // Sign-off
  html += sectionBox('From the Crew',
    '<div style="font-size:14px;color:#374151;line-height:1.7;">' +
      'Your feedback means the world to us and helps other Lake Travis adventurers find us.' +
      portalSentence +
      '<br><br>' +
      'See you on the water!<br>' +
      '<strong>&mdash; DJ &amp; Dane</strong><br>' +
      'Texas Forever Charters<br>' +
      '<a href="tel:+17373681669" style="color:#C8102E;text-decoration:none;font-weight:700;">(737) 368-1669</a>' +
    '</div>');
  html += divider();
  html += emailFooter();

  return emailWrapper(html);
}

async function sendReviewRequestEmail(booking) {
  if (!booking || !booking.customer_email) {
    console.log('[send-emails] sendReviewRequestEmail: no customer_email — skipping');
    return null;
  }
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');
  console.log('[send-emails] Sending review request to:', booking.customer_email, 'session:', booking.session_id);
  const result = await postToResend({
    from:     FROM_EMAIL,
    to:       [booking.customer_email],
    reply_to: BUSINESS_EMAIL,
    subject:  'How Was Your Charter? — Texas Forever Charters',
    html:     buildReviewRequestEmail(booking),
  });
  console.log('[send-emails] Review request sent OK. Resend id:', result.id);
  return result;
}

module.exports = {
  sendConfirmationEmails, postToResend,
  sendCancellationEmail, sendRefundEmail, sendDamageChargeEmail,
  sendAdminActionEmailFailureAlert,
  sendBlackoutConflictAlert,
  sendDamageHoldFailedAlert,
  sendDamageHoldFailedCustomerNotice,
  sendConfirmationEmailPermanentFailureAlert,
  sendStripeRefundReconciledAlert,
  sendChargebackAlert,
  sendHighValueLeadAlert,
  sendDailyLeadDigest,
  sendWaiverLinkEmail, sendWaiverConfirmationEmail,
  sendPortalLinkEmail, sendBalancePaidEmail,
  sendFriendlyReminderEmail, sendDueTodayEmail, sendOwnerAlertEmail, sendFinalNoticeEmail,
  sendReviewRequestEmail,
  formatMoney, formatMoneyDollars,
  FROM_EMAIL,
  PORTAL_BASE_URL,
};
