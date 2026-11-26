import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  PUBLIC_URL: z.string().url(), DATABASE_URL: z.string().min(1),
  MCP_BEARER_TOKEN: z.string().min(32), ADMIN_BEARER_TOKEN: z.string().min(32),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[a-fA-F0-9]{64}$/),
  OLIST_ACCOUNT_ID: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  OLIST_CLIENT_ID: z.string().min(1), OLIST_CLIENT_SECRET: z.string().min(1),
  OLIST_REDIRECT_URI: z.string().url(),
  OLIST_READ_RPM: z.coerce.number().int().min(1).max(10000).default(30),
  // Escrita real é opt-in em duas camadas: modo global + lista de operações. Padrão: somente leitura.
  WRITE_MODE: z.enum(['disabled', 'enabled']).default('disabled'),
  WRITE_OPERATIONS: z.string().default('').transform(v => v.split(',').map(s => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(['stock', 'price', 'product', 'sku', 'create', 'delete']))),
  // admin: humano aprova no painel /admin com o Bearer administrativo. client: o cliente MCP pede a aprovação (mais fraco).
  APPROVAL_MODE: z.enum(['admin', 'client']).default('admin'),
  PROPOSAL_TTL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  MAX_BATCH_ITEMS: z.coerce.number().int().min(1).max(1000).default(200),
  MAX_PRICE_CHANGE_PCT: z.coerce.number().min(1).max(500).default(30),
  // PUT /produtos/{id} pode substituir o cadastro inteiro; só habilite depois de homologar em produto de teste.
  OLIST_PRODUCT_PUT_VERIFIED: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  // Test products where product/SKU edits may run before global homologation (comma-separated Olist IDs).
  HOMOLOGATION_PRODUCT_IDS: z.string().default('').transform(v => v.split(',').map(s => s.trim()).filter(Boolean).map(Number))
    .pipe(z.array(z.number().int().positive().safe())),
  // Read-only = ChatGPT only queries; prepare = ChatGPT may also create proposals (never confirm/approve).
  TUNNEL_TOOLSET: z.enum(['read', 'prepare']).default('read'),
  // Loopback-only, read-only MCP listener for OpenAI Secure MCP Tunnel (ChatGPT). Empty = disabled.
  TUNNEL_MCP_PORT: z.preprocess(v => v === '' ? undefined : v, z.coerce.number().int().min(1).max(65535).optional()),
  // Injected by tunnel-client (--mcp.extra-headers); never configured in ChatGPT.
  TUNNEL_MCP_BEARER_TOKEN: z.preprocess(v => v === '' ? undefined : v, z.string().min(32).optional()),
  AUTOMATIONS_TICK_SECONDS: z.coerce.number().int().min(10).max(3600).default(60),
  ML_CLIENT_ID: z.string().optional(), ML_CLIENT_SECRET: z.string().optional(),
  NUVEMSHOP_CLIENT_ID: z.string().optional(), NUVEMSHOP_CLIENT_SECRET: z.string().optional(),
  SHOPEE_PARTNER_ID: z.string().optional(), SHOPEE_PARTNER_KEY: z.string().optional(),
  TIKTOK_APP_KEY: z.string().optional(), TIKTOK_APP_SECRET: z.string().optional(),
  SHEIN_APP_ID: z.string().optional(), SHEIN_APP_SECRET: z.string().optional()
});
export type Config = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  // Never include values or Zod's raw input in errors.
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`);
  const c = parsed.data;
  const base = new URL(c.PUBLIC_URL);
  const callback = new URL(c.OLIST_REDIRECT_URI);
  if (base.origin !== callback.origin || callback.pathname !== '/oauth/olist/callback' || callback.search || callback.hash)
    throw new Error('Callback must match PUBLIC_URL origin and /oauth/olist/callback');
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password)
    throw new Error('PUBLIC_URL must be an origin');
  if (c.NODE_ENV === 'production' && base.protocol !== 'https:') throw new Error('Production requires HTTPS');
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('HTTP only allowed on loopback');
  if (c.MCP_BEARER_TOKEN === c.ADMIN_BEARER_TOKEN) throw new Error('Use separate MCP and admin tokens');
  if (c.TUNNEL_MCP_PORT === c.PORT) throw new Error('TUNNEL_MCP_PORT must differ from PORT');
  if (c.TUNNEL_MCP_PORT && !c.TUNNEL_MCP_BEARER_TOKEN) throw new Error('TUNNEL_MCP_PORT requires TUNNEL_MCP_BEARER_TOKEN');
  if (c.TUNNEL_MCP_BEARER_TOKEN && [c.MCP_BEARER_TOKEN, c.ADMIN_BEARER_TOKEN].includes(c.TUNNEL_MCP_BEARER_TOKEN)) throw new Error('Use a distinct tunnel token');
  if (c.WRITE_MODE === 'enabled' && c.APPROVAL_MODE === 'client' && c.NODE_ENV === 'production')
    throw new Error('Production writes require APPROVAL_MODE=admin');
  return c;
}
