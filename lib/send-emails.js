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

function formatMoney(cents) {
  return '$' + (cents / 100).toFixed(2);
}

function parseAddOns(json) {
  try { return JSON.parse(json || '{}'); } catch { return {}; }
}

function addOnLines(addOns) {
  const lines = [];
  if (addOns.drone)        lines.push('Drone Footage — $200');
  if (addOns.towels > 0)   lines.push('Towels (' + addOns.towels + ' x $8) — $' + (addOns.towels * 8));
  if (addOns.water)        lines.push('Water Bottles — $25');
  if (addOns.ice)          lines.push('Ice — $50');
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
      '<div style="font-size:26px;font-weight:900;color:#D97706;font-family:Arial,sans-serif;">$' + remaining.toFixed(2) + '</div>' +
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
      '<strong>Reminder:</strong> Your remaining balance of <strong>$' + remaining.toFixed(2) + '</strong> ' +
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

  // Next steps
  const steps = [
    ['Check your email', 'A Stripe receipt has been sent separately. Check your spam if you don&rsquo;t see it.'],
    ['We&rsquo;ll call you', 'Expect a call or text from your captain 48 hours before departure to confirm details.'],
    ['Show up &amp; enjoy', 'Meet at <strong>Volente Beach Waterpark &amp; Resort</strong>. Arrive 15 min early. BYOB welcome.'],
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
    ['Remaining',      remaining > 0 ? '$' + remaining.toFixed(2) + ' (due 7 days before charter)' : '$0.00 — fully paid'],
    ['Total Value',    d.grand_total ? '$' + parseFloat(d.grand_total).toFixed(2) : '—'],
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
  const refundFmt = '$' + Number(refundDollars).toFixed(2);

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
      '<strong>$' + Number(remainingDollars).toFixed(2) + '</strong>. ' +
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
  console.log('[send-emails] Sending', isFullRefund ? 'full' : 'partial', 'refund email to:', booking.customer_email, 'session:', booking.session_id, '| amount: $' + Number(refundDollars).toFixed(2));
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
  const chargeFmt = '$' + Number(chargeDollars).toFixed(2);

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
  console.log('[send-emails] Sending damage charge email to:', booking.customer_email, 'session:', booking.session_id, '| amount: $' + Number(chargeDollars).toFixed(2));
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

/* ── Payment reminder emails ── */

function moneyDollars(n) {
  return '$' + Number(n || 0).toFixed(2);
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
      'Your feedback means the world to us and helps other Lake Travis adventurers find us.<br><br>' +
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
  sendDamageHoldFailedAlert,
  sendWaiverLinkEmail, sendWaiverConfirmationEmail,
  sendFriendlyReminderEmail, sendDueTodayEmail, sendOwnerAlertEmail, sendFinalNoticeEmail,
  sendReviewRequestEmail,
};
