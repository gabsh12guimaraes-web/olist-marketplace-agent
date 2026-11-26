CREATE TABLE IF NOT EXISTS oauth_tokens (
  account_id text PRIMARY KEY,
  encrypted_payload text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash text PRIMARY KEY,
  binding_hash text NOT NULL,
  account_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS rate_slots (
  account_id text PRIMARY KEY,
  next_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  tool text NOT NULL,
  request_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('started','success','error')),
  error_code text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS audit_account_time ON audit_events(account_id, created_at);
CREATE TABLE IF NOT EXISTS id_mappings (
  account_id text NOT NULL,
  provider text NOT NULL,
  entity_type text NOT NULL,
  external_id text NOT NULL,
  canonical_id uuid NOT NULL,
  sku text,
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(account_id, provider, entity_type, external_id)
);
CREATE INDEX IF NOT EXISTS mapping_sku ON id_mappings(account_id, provider, sku);
