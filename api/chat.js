const https = require('https');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const { model, max_tokens, system, messages } = req.body;
  const body = JSON.stringify({ model, max_tokens, system, messages });

  return new Promise((resolve) => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    };

    const request = https.request(options, (upstream) => {
      let data = '';
      upstream.on('data', (chunk) => { data += chunk; });
      upstream.on('end', () => {
        try {
          res.status(upstream.statusCode).json(JSON.parse(data));
        } catch (e) {
          console.error('Failed to parse Anthropic response:', data);
          res.status(502).json({ error: 'Invalid response from Anthropic' });
        }
        resolve();
      });
    });

    request.on('error', (err) => {
      console.error('Anthropic request error:', err.message);
      res.status(502).json({ error: 'Upstream request failed', detail: err.message });
      resolve();
    });

    request.write(body);
    request.end();
  });
};
