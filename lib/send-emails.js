const https = require('https');

const FROM_EMAIL = 'Texas Forever Charters <bookings@texasforevercharters.com>';
const BUSINESS_EMAIL = 'tx4evercharters@gmail.com';

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

  if (remaining > 0) {
    paymentHtml += '<div style="background:#FEF3C7;border:1px solid #FDE68A;border-radius:8px;' +
      'padding:12px 16px;margin-top:14px;font-size:13px;color:#92400E;line-height:1.6;">' +
      '<strong>Reminder:</strong> Your remaining balance of <strong>$' + remaining.toFixed(2) + '</strong> ' +
      'is due <strong>7 days before your charter date</strong>. ' +
      'We&rsquo;ll reach out ahead of time to collect. Questions? Call us at (737) 368-1669.' +
      '</div>';
  }

  html += sectionBox('Payment Summary', paymentHtml);
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

/* ── Main export ── */
async function sendConfirmationEmails(data) {
  console.log('[send-emails] sendConfirmationEmails called for session:', data.session_id,
    '| customer:', data.customer_email, '| charter:', data.charter_name, '| date:', data.date);

  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not configured');
  }

  const customerSubject = 'Booking Confirmed: ' + (data.charter_name || 'Your Charter') +
    ' — ' + formatDate(data.date);
  const businessSubject = 'New Booking: ' + (data.charter_name || '?') +
    ' | ' + (data.experience || '') + ' | ' + formatDate(data.date);

  const customerEmail = data.customer_email;
  if (!customerEmail) throw new Error('No customer email in session data');

  // Send independently so a failure on one is visible and doesn't suppress the other.
  let customerResult, businessResult;

  console.log('[send-emails] Sending customer confirmation to:', customerEmail);
  try {
    customerResult = await postToResend({
      from:     FROM_EMAIL,
      to:       [customerEmail],
      reply_to: BUSINESS_EMAIL,
      subject:  customerSubject,
      html:     buildCustomerEmail(data),
    });
    console.log('[send-emails] Customer email sent OK. Resend id:', customerResult.id);
  } catch (err) {
    console.error('[send-emails] ERROR sending customer email:', err.message);
    throw err;
  }

  console.log('[send-emails] Sending business notification to:', BUSINESS_EMAIL);
  try {
    businessResult = await postToResend({
      from:     FROM_EMAIL,
      to:       [BUSINESS_EMAIL],
      reply_to: customerEmail,
      subject:  businessSubject,
      html:     buildBusinessEmail(data),
    });
    console.log('[send-emails] Business email sent OK. Resend id:', businessResult.id);
  } catch (err) {
    console.error('[send-emails] ERROR sending business notification to', BUSINESS_EMAIL, ':', err.message);
    throw err;
  }

  return { customerResult, businessResult };
}

module.exports = { sendConfirmationEmails };
