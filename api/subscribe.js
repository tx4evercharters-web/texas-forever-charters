const https = require('https');
const crypto = require('crypto');

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

  const apiKey = process.env.MAILCHIMP_API_KEY;
  const audienceId = process.env.MAILCHIMP_AUDIENCE_ID;

  if (!apiKey || !audienceId) {
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
      upstream.on('end', () => {
        if (upstream.statusCode === 200) {
          res.status(200).json({ success: true });
        } else {
          try {
            const parsed = JSON.parse(data);
            res.status(400).json({ error: parsed.title || 'Subscription failed' });
          } catch {
            res.status(502).json({ error: 'Upstream error' });
          }
        }
        resolve();
      });
    });

    request.on('error', (err) => {
      res.status(502).json({ error: 'Request failed', detail: err.message });
      resolve();
    });

    request.write(body);
    request.end();
  });
};
