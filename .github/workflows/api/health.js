const { UnsupportedProvider } = require('../lib/core');
module.exports = (req, res) => {
  const p = new UnsupportedProvider();
  res.status(200).json({
    status: 'DEGRADED', reason: 'No financial provider connected',
    provider: { name: p.name, capabilities: p.capabilities() },
    store: process.env.DATABASE_URL ? 'POSTGRES (configured; verify with CI contract tests)' : process.env.ALLOW_EPHEMERAL_STORE === '1' ? 'EPHEMERAL_MEMORY (state lost between calls)' : 'UNSUPPORTED',
    sandbox: 'UNAVAILABLE', deployment: 'UNVERIFIED',
  });
};
