module.exports = function handler(req, res) {
  res.status(200).json({
    key_present: !!process.env.ANTHROPIC_API_KEY,
    env_keys: Object.keys(process.env).filter(k => k.includes('ANTHROP')),
  });
};
