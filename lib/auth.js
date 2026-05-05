const crypto = require('crypto');

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateToken(password) {
  const ts = Date.now().toString();
  const hash = crypto.createHmac('sha256', password).update(ts).digest('hex');
  return hash + '.' + ts;
}

function verifyToken(token) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || !token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const hash = token.slice(0, dot);
  const ts = token.slice(dot + 1);
  const age = Date.now() - parseInt(ts, 10);
  if (isNaN(age) || age < 0 || age > TOKEN_TTL_MS) return false;
  const expected = crypto.createHmac('sha256', password).update(ts).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function requireAuth(req, res) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!verifyToken(token)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

module.exports = { generateToken, verifyToken, requireAuth };
