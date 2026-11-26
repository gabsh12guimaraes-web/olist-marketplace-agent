-- Fase B: propostas de alteração, execução retomável, vínculos de anúncios, automações e auditoria ampliada.
-- Idempotente: pode ser reaplicada. Não altera dados existentes de 001_init.sql.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'read';
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS proposal_id uuid;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS details jsonb;
CREATE INDEX IF NOT EXISTS audit_proposal ON audit_events(proposal_id) WHERE proposal_id IS NOT NULL;

-- Proposta = intenção preparada. Nunca executa sem status 'approved' validado pelo servidor.
CREATE TABLE IF NOT EXISTS change_proposals (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('stock','price','product','sku','batch')),
  status text NOT NULL CHECK (status IN ('preparing','pending','executing','succeeded','partial','failed','expired','cancelled','rejected','blocked')),
  summary text NOT NULL,
  risks jsonb NOT NULL DEFAULT '[]',
  blocked_reason text,
  request jsonb NOT NULL,
  fingerprint text NOT NULL,
  confirmation_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  approved_by text,
  started_at timestamptz,
  finished_at timestamptz,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS proposals_account_status ON change_proposals(account_id, status, created_at);
-- Impede duas propostas abertas idênticas (execução duplicada por repetição do agente).
CREATE UNIQUE INDEX IF NOT EXISTS proposals_open_fingerprint ON change_proposals(account_id, fingerprint)
  WHERE status IN ('preparing','pending','executing');

CREATE TABLE IF NOT EXISTS change_items (
  proposal_id uuid NOT NULL REFERENCES change_proposals(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  operation text NOT NULL,
  target jsonb NOT NULL,
  before jsonb,
  after jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','skipped','invalid','succeeded','failed','conflict','unknown')),
  message text,
  response jsonb,
  verified boolean,
  executed_at timestamptz,
  PRIMARY KEY (proposal_id, seq)
);

-- Vínculo entre cadastro Olist e anúncios. SKU nunca é chave universal.
CREATE TABLE IF NOT EXISTS channel_listings (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  olist_product_id bigint,
  olist_parent_id bigint,
  sku text,
  variation_sku text,
  provider text NOT NULL,
  store_id text NOT NULL DEFAULT '',
  marketplace_product_id text,
  listing_id text NOT NULL,
  marketplace_variation_id text NOT NULL DEFAULT '',
  deposit_id bigint,
  sync_policy text NOT NULL DEFAULT 'olist_master' CHECK (sync_policy IN ('olist_master','marketplace_master','manual','disabled')),
  source text NOT NULL DEFAULT 'manual',
  listing_status text,
  observed_stock numeric,
  observed_price numeric,
  observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, provider, store_id, listing_id, marketplace_variation_id)
);
CREATE INDEX IF NOT EXISTS listings_olist ON channel_listings(account_id, olist_product_id);
CREATE INDEX IF NOT EXISTS listings_sku ON channel_listings(account_id, sku);

-- Proteções configuráveis de preço. Nenhum custo/margem é presumido.
CREATE TABLE IF NOT EXISTS price_guards (
  account_id text NOT NULL,
  olist_product_id bigint NOT NULL,
  min_price numeric,
  min_margin_pct numeric,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, olist_product_id)
);

-- Automações começam desativadas; somente o painel administrativo as habilita.
CREATE TABLE IF NOT EXISTS automations (
  account_id text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  interval_minutes integer NOT NULL DEFAULT 60 CHECK (interval_minutes >= 5),
  last_run_at timestamptz,
  lease_until timestamptz,
  last_result jsonb,
  PRIMARY KEY (account_id, name)
);

-- Credenciais de marketplaces: mesmo esquema criptografado dos tokens Olist (AAD = conta:provedor:loja).
CREATE TABLE IF NOT EXISTS marketplace_tokens (
  account_id text NOT NULL,
  provider text NOT NULL,
  store_id text NOT NULL,
  encrypted_payload text NOT NULL,
  expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, provider, store_id)
);
