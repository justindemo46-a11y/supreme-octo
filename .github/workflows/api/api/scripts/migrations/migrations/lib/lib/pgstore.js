'use strict';
// Postgres implementation of the store contract. UNVERIFIED until test/store.contract.test.js passes against a real database
// (see .github/workflows/test.yml). All SQL is parameterized; patch columns are allow-listed.
const crypto = require('crypto');
const { TRANSITIONS } = require('./core');
const h = s => crypto.createHash('sha256').update(s).digest('hex');
const JSONCOLS = { risk: 'risk', approval: 'approval', result: 'result' };
const ms = v => new Date(v).getTime();
const fromRow = r => r && ({ id: r.id, userId: r.user_id, amountMinor: Number(r.amount_minor), currency: r.currency, destination: r.destination, purpose: r.purpose, idempotencyKey: r.idempotency_key, state: r.state, paramsHash: r.params_hash, risk: r.risk, approval: r.approval, result: r.result, reconciliationRequired: r.reconciliation_required, createdAt: ms(r.created_at), updatedAt: ms(r.updated_at), expiresAt: ms(r.expires_at) });
function sets(patch, vals) {
  const out = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k in JSONCOLS) { vals.push(JSON.stringify(v)); out.push(`${JSONCOLS[k]}=$${vals.length}::jsonb`); }
    else if (k === 'reconciliationRequired') { vals.push(!!v); out.push(`reconciliation_required=$${vals.length}`); }
    else throw new Error('BAD_PATCH_COLUMN');
  }
  return out;
}
class PgStore {
  constructor(pool) { this.pool = pool; this.kind = 'POSTGRES'; }
  static fromUrl(url) { const { Pool } = require('pg'); return new PgStore(new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 8000 })); }
  async tx(fn) {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { try { await c.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { c.release(); }
  }
  async _audit(c, e) { // hash chain; advisory lock serializes appends so the chain cannot fork
    await c.query('SELECT pg_advisory_xact_lock(7001)');
    const { rows } = await c.query('SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1');
    const prevHash = rows[0] ? rows[0].hash : '0', payload = JSON.stringify(e), hash = h(prevHash + payload);
    await c.query('INSERT INTO audit_events (ts, actor, event, request_id, action_id, prev_state, next_state, body, prev_hash, hash, payload) VALUES (to_timestamp($1/1000.0),$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)',
      [e.ts, e.actor, e.event, e.requestId || null, e.actionId || null, e.prev || null, e.next || null, payload, prevHash, hash, payload]);
    return { ...e, prevHash, hash };
  }
  appendAudit(e) { return this.tx(c => this._audit(c, e)); }
  async getOrCreate(userId, key, build) {
    const a = build();
    const ins = await this.pool.query(`INSERT INTO actions (id,user_id,amount_minor,currency,destination,purpose,idempotency_key,state,params_hash,reconciliation_required,created_at,updated_at,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,false,to_timestamp($9/1000.0),to_timestamp($9/1000.0),to_timestamp($10/1000.0))
      ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`, [a.id, userId, a.amountMinor, a.currency, a.destination, a.purpose, key, a.paramsHash, a.createdAt, a.expiresAt]);
    if (ins.rows.length) return { action: fromRow(ins.rows[0]), created: true };
    const ex = await this.pool.query('SELECT * FROM actions WHERE user_id=$1 AND idempotency_key=$2', [userId, key]);
    return { action: fromRow(ex.rows[0]), created: false };
  }
  async get(id) { return fromRow((await this.pool.query('SELECT * FROM actions WHERE id=$1', [id])).rows[0]); }
  async listByUser(u, limit = 100) { return (await this.pool.query('SELECT * FROM actions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [u, limit])).rows.map(fromRow); }
  async cas(id, from, to, patch = {}, ev, entry) {
    if (!(TRANSITIONS[from] || []).includes(to)) return null;
    return this.tx(async c => {
      const vals = [id, from, to], s = ['state=$3', 'updated_at=now()', ...sets(patch, vals)];
      const { rows } = await c.query(`UPDATE actions SET ${s.join(',')} WHERE id=$1 AND state=$2 RETURNING *`, vals);
      if (!rows.length) return null;
      if (entry) await c.query('INSERT INTO accounting_entries (id,action_id,type,amount_minor,currency,source,provider_tx_id,ts) VALUES ($1,$2,$3,$4,$5,$6,$7,to_timestamp($8/1000.0))', [entry.id, entry.actionId, entry.type, entry.amountMinor, entry.currency, entry.source, entry.providerTxId, entry.ts]);
      if (ev) await this._audit(c, ev);
      return fromRow(rows[0]);
    });
  }
  async patch(id, patch) { const vals = [id], s = sets(patch, vals); if (s.length) await this.pool.query(`UPDATE actions SET ${s.join(',')}, updated_at=now() WHERE id=$1`, vals); }
  async exposure(u, excludeId, dayStart) {
    const { rows } = await this.pool.query(`SELECT
      COALESCE(SUM(amount_minor) FILTER (WHERE state IN ('APPROVED','VALIDATING','EXECUTING')),0) AS reserved,
      COALESCE(SUM(amount_minor) FILTER (WHERE state IN ('COMPLETED','APPROVED','VALIDATING','EXECUTING') AND created_at >= to_timestamp($3/1000.0) AND created_at < to_timestamp($3/1000.0) + interval '1 day'),0) AS spent
      FROM actions WHERE user_id=$1 AND ($2::uuid IS NULL OR id <> $2::uuid)`, [u, excludeId || null, dayStart]);
    return { reservedMinor: Number(rows[0].reserved), spentTodayMinor: Number(rows[0].spent) };
  }
  async recentAudit(n) { return (await this.pool.query('SELECT payload, seq, hash, prev_hash FROM audit_events ORDER BY seq DESC LIMIT $1', [n])).rows.reverse().map(r => ({ ...JSON.parse(r.payload), seq: Number(r.seq), hash: r.hash, prevHash: r.prev_hash })); }
  async verifyChain() { const { rows } = await this.pool.query('SELECT hash, prev_hash, payload FROM audit_events ORDER BY seq'); let p = '0'; return rows.every(r => { const ok = r.prev_hash === p && r.hash === h(p + r.payload); p = r.hash; return ok; }); }
  async getLimits(u) { const r = await this.pool.query('SELECT limits FROM user_limits WHERE user_id=$1', [u]); return r.rows[0] ? r.rows[0].limits : null; }
  async setLimits(u, l) { await this.pool.query('INSERT INTO user_limits (user_id, limits) VALUES ($1,$2::jsonb) ON CONFLICT (user_id) DO UPDATE SET limits=EXCLUDED.limits, updated_at=now()', [u, JSON.stringify(l)]); }
  async getMode(u) { const r = await this.pool.query('SELECT mode FROM emergency_states WHERE user_id=$1', [u]); return r.rows[0] ? r.rows[0].mode : 'NORMAL'; }
  async setMode(u, m) { await this.pool.query('INSERT INTO emergency_states (user_id, mode) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET mode=EXCLUDED.mode', [u, m]); }
  async incFails(u) { const r = await this.pool.query("INSERT INTO emergency_states (user_id, mode, fail_count) VALUES ($1,'NORMAL',1) ON CONFLICT (user_id) DO UPDATE SET fail_count = emergency_states.fail_count + 1 RETURNING fail_count", [u]); return r.rows[0].fail_count; }
  async resetFails(u) { await this.pool.query("INSERT INTO emergency_states (user_id, mode, fail_count) VALUES ($1,'NORMAL',0) ON CONFLICT (user_id) DO UPDATE SET fail_count=0", [u]); }
}
module.exports = { PgStore };
