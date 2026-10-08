// Usage: DATABASE_URL=... node scripts/migrate.js   (applies migrations/*.sql once each, in order)
const fs = require('fs'), path = require('path');
(async () => {
  const url = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL'); process.exit(1); }
  const { Client } = require('pg'); const c = new Client({ connectionString: url }); await c.connect();
  await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = path.join(__dirname, '..', 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if ((await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f])).rowCount) continue;
    await c.query('BEGIN');
    try { await c.query(fs.readFileSync(path.join(dir, f), 'utf8')); await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]); await c.query('COMMIT'); console.log('applied', f); }
    catch (e) { await c.query('ROLLBACK'); console.error('FAILED', f, e.message); process.exit(1); }
  }
  await c.end();
})();
