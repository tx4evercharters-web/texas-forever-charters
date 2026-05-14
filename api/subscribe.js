const https = require('https');
const crypto = require('crypto');
const { FROM_EMAIL } = require('../lib/send-emails');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

module.exports = async function handler(req, res) {
  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  console.log('[subscribe] received:', email);

  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;

  if (!apiKey || !audienceId) {
    console.error('[subscribe] missing env vars',
      { MAILCHIMP_API_KEY: !!apiKey, MAILCHIMP_AUDIENCE_ID: !!audienceId });
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const dc = apiKey.split('-').pop();
  const subscriberHash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');
  const body = JSON.stringify({ email_address: email, status: 'subscribed' });

  return new Promise((resolve) => {
    const options = {
      hostname: `${dc}.api.mailchimp.com`,
      path: `/3.0/lists/${audienceId}/members/${subscriberHash}`,
      method: 'PUT',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`anystring:${apiKey}`).toString('base64'),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const request = https.request(options, (upstream) => {
      let data = '';
      upstream.on('data', chunk => { data += chunk; });
      upstream.on('end', async () => {
        console.log('[subscribe] mailchimp status:', upstream.statusCode);
        if (upstream.statusCode === 200) {
          // Send welcome email with promo code (best-effort, capped at 5s)
          try {
            const resendBody = JSON.stringify({
              from: FROM_EMAIL,
              to: email,
              subject: 'Your 10% Off Promo Code — Texas Forever Charters',
              html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0F1A45;"><div style="background:#1B2A6B;padding:24px;text-align:center;border-bottom:3px solid #C8102E;"><h1 style="color:#fff;margin:0;font-size:22px;letter-spacing:3px;">TEXAS FOREVER CHARTERS</h1></div><div style="padding:32px 24px;text-align:center;"><p style="color:rgba(255,255,255,0.8);font-size:16px;">Welcome to the crew! Here's your exclusive discount:</p><div style="background:#C8102E;border-radius:8px;padding:20px;margin:24px 0;"><div style="color:rgba(255,255,255,0.7);font-size:12px;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">Your Promo Code</div><div style="color:#fff;font-size:36px;font-weight:900;letter-spacing:6px;">LAKELIFE10</div><div style="color:rgba(255,255,255,0.7);font-size:12px;margin-top:8px;">10% off your charter rate</div></div><p style="color:rgba(255,255,255,0.7);font-size:14px;">Enter this code at checkout on Step 8 of the booking process.</p><div style="margin:28px 0;"><a href="https://www.texasforevercharters.com/booking.html" style="background:#C8102E;color:#fff;padding:14px 32px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px;">Book Your Charter</a></div><p style="color:rgba(255,255,255,0.4);font-size:12px;">Questions? Call or text (737) 368-1669</p></div></div>`,
            });
            await new Promise((resolveEmail) => {
              let settled = false;
              const done = () => { if (!settled) { settled = true; resolveEmail(); } };
              const emailReq = https.request({ hostname: 'api.resend.com', path: '/emails', method: 'POST', headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(resendBody) } }, (r) => {
                let respData = '';
                r.on('data', c => { respData += c; });
                r.on('end', () => {
                  if (r.statusCode < 200 || r.statusCode >= 300) console.error('[subscribe] resend non-2xx:', r.statusCode, respData);
                  else console.log('[subscribe] resend OK:', r.statusCode);
                  done();
                });
              });
              emailReq.on('error', (err) => { console.error('Resend request error:', err.message); done(); });
              emailReq.setTimeout(5000, () => { console.error('Resend request timed out after 5s'); emailReq.destroy(); done(); });
              emailReq.write(resendBody);
              emailReq.end();
            });
          } catch(e) { console.error('Welcome email failed:', e.message); }
          res.status(200).json({ success: true });
        } else {
          console.error('[subscribe] mailchimp non-200:', upstream.statusCode, data);
          try {
            const parsed = JSON.parse(data);
            res.status(400).json({
              error: parsed.title || 'Subscription failed',
              detail: parsed.detail || null,
              status: upstream.statusCode,
            });
          } catch {
            res.status(502).json({ error: 'Upstream error', status: upstream.statusCode });
          }
        }
        resolve();
      });
    });

    request.on('error', (err) => {
      console.error('[subscribe] mailchimp request error:', err.message);
      res.status(502).json({ error: 'Request failed', detail: err.message });
      resolve();
    });

    request.write(body);
    request.end();
  });
};
