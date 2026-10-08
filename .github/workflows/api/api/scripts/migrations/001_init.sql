-- Postgres schema (NOT wired to the app yet). Invariants enforced in the database.
CREATE TABLE actions (
  id uuid PRIMARY KEY, user_id text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0), currency char(3) NOT NULL,
  destination text NOT NULL, purpose text NOT NULL, idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('PENDING','APPROVED','VALIDATING','EXECUTING','COMPLETED','REJECTED','FAILED','CANCELLED','EXPIRED')),
  params_hash text NOT NULL, risk jsonb, approval jsonb, result jsonb,
  reconciliation_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX actions_user_state ON actions (user_id, state);
CREATE TABLE audit_events (
  seq bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), actor text NOT NULL, event text NOT NULL,
  request_id text, action_id uuid, prev_state text, next_state text, body jsonb, prev_hash text NOT NULL, hash text NOT NULL
);
CREATE FUNCTION audit_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit_events is append-only'; END $$ LANGUAGE plpgsql;
CREATE TRIGGER audit_no_mutation BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_immutable();
CREATE FUNCTION state_transition_guard() RETURNS trigger AS $$ BEGIN
  IF OLD.state = NEW.state THEN RETURN NEW; END IF;
  IF (OLD.state, NEW.state) IN (('PENDING','APPROVED'),('PENDING','REJECTED'),('PENDING','CANCELLED'),('PENDING','EXPIRED'),('APPROVED','VALIDATING'),('APPROVED','CANCELLED'),('APPROVED','EXPIRED'),('VALIDATING','EXECUTING'),('VALIDATING','REJECTED'),('VALIDATING','FAILED'),('EXECUTING','COMPLETED'),('EXECUTING','FAILED'))
  THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid transition % -> %', OLD.state, NEW.state; END $$ LANGUAGE plpgsql;
CREATE TRIGGER actions_transition BEFORE UPDATE ON actions FOR EACH ROW EXECUTE FUNCTION state_transition_guard();
CREATE TABLE accounting_entries (
  id uuid PRIMARY KEY, action_id uuid NOT NULL REFERENCES actions(id), type text NOT NULL,
  amount_minor bigint NOT NULL, currency char(3) NOT NULL,
  source text NOT NULL CHECK (source IN ('REAL_PROVIDER_DATA','USER_INPUT','CALCULATED','ESTIMATED','SIMULATED','UNKNOWN')),
  provider_tx_id text, ts timestamptz NOT NULL DEFAULT now(), UNIQUE (action_id, type)
);
CREATE TABLE user_limits (user_id text PRIMARY KEY, limits jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE emergency_states (user_id text PRIMARY KEY, mode text NOT NULL CHECK (mode IN ('NORMAL','CAUTIOUS','DEFENSIVE','EMERGENCY','LOCKDOWN')), fail_count int NOT NULL DEFAULT 0);
