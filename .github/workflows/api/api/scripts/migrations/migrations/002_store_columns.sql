ALTER TABLE actions ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE audit_events ADD COLUMN payload text NOT NULL DEFAULT '';
CREATE INDEX audit_action ON audit_events (action_id);
