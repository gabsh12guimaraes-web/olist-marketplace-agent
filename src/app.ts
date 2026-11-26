import { randomUUID } from 'node:crypto';
import express, { type RequestHandler, type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from './config.ts';
import type { Pool } from './db.ts';
import { remember } from './db.ts';
import type { OAuth } from './oauth.ts';
import type { ReadAdapter, WriteAdapter } from './adapters/contracts.ts';
import { authorized } from './security.ts';
import { createMcpServer } from './tools.ts';
import { connectPage, connectScript } from './connect-page.ts';
import { adminPage, adminScript } from './admin-page.ts';
import { ChangeError, ChangeService } from './changes.ts';
import { planBatch, batchRequest } from './batch.ts';
import { listingsFor } from './mapping.ts';
import { listAutomations, setAutomation } from './automations.ts';
import { marketplaceStatus, olistDescriptor } from './adapters/marketplaces.ts';
import type { Operations } from './tools-ops.ts';

const noWriter: WriteAdapter = { async send() { throw new Error('Write adapter unavailable'); } };
export function buildOperations(config: Config, pool: Pool, oauth: OAuth, adapter: ReadAdapter & Partial<WriteAdapter>): Operations {
  const account = config.OLIST_ACCOUNT_ID;
  const lookups = {
    async priceGuard(id: number) { return (await pool.query('SELECT min_price,min_margin_pct FROM price_guards WHERE account_id=$1 AND olist_product_id=$2', [account, id])).rows[0] ?? null; },
    async listings(id: number) { return listingsFor(pool, account, id); }
  };
  const limits = { maxPriceChangePct: config.MAX_PRICE_CHANGE_PCT, productPutVerified: config.OLIST_PRODUCT_PUT_VERIFIED, homologationProductIds: config.HOMOLOGATION_PRODUCT_IDS, maxItems: config.MAX_BATCH_ITEMS };
  const writer = typeof adapter.send === 'function' ? adapter as WriteAdapter : noWriter;
  const changes = new ChangeService({ pool, config, reader: adapter, writer, planBatch: request => planBatch(adapter, lookups, limits, batchRequest.parse(request)) });
  return { pool, config, account, changes, lookups, limits, tokenStatus: () => oauth.status(),
    marketplaces: () => ({ olist: olistDescriptor, canais: marketplaceStatus(config) }) };
}

export function createApp(config: Config, pool: Pool, oauth: OAuth, adapter: ReadAdapter & Partial<WriteAdapter>, logger: Logger, ops = buildOperations(config, pool, oauth, adapter)) {
  const app = express(); app.disable('x-powered-by');
  const origin = new URL(config.PUBLIC_URL);
  app.use(helmet({ contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': origin.protocol === 'https:' ? [] : null } }, strictTransportSecurity: origin.protocol === 'https:' ? undefined : false }));
  app.use((req, res, next) => {
    const requestId = randomUUID(); res.locals.requestId = requestId; res.setHeader('X-Request-Id', requestId);
    res.setHeader('Cache-Control', 'no-store');
    // Validate exact configured public Host even behind the reverse proxy; don't trust forwarded headers.
    if (req.headers.host !== origin.host || (req.headers.origin && req.headers.origin !== origin.origin)) { res.status(403).json({ error: 'Forbidden', request_id: requestId }); return; }
    next();
  });
  function auth(secret: string): RequestHandler {
    return (req, res, next) => {
      if (!authorized(req.headers.authorization, secret)) { res.setHeader('WWW-Authenticate', 'Bearer realm="olist-marketplace-agent"'); res.status(401).json({ error: 'Unauthorized' }); return; }
      next();
    };
  }
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/readyz', auth(config.ADMIN_BEARER_TOKEN), async (_req, res) => { await pool.query('SELECT 1'); res.json({ status: 'ready' }); });
  app.get('/oauth/olist/connect', (_req, res) => { res.type('html').send(connectPage); });
  app.get('/oauth/olist/connect.js', (_req, res) => { res.type('js').send(connectScript); });
  app.post('/oauth/olist/start', auth(config.ADMIN_BEARER_TOKEN), express.json({ limit: '4kb' }), async (req, res) => {
    if (req.body?.registered_redirect_uri !== config.OLIST_REDIRECT_URI) {
      res.status(400).json({ error: 'Callback mismatch' }); return;
    }
    const { url, binding } = await oauth.start();
    res.cookie('olist_oauth_binding', binding, { httpOnly: true, secure: origin.protocol === 'https:', sameSite: 'lax', path: '/oauth/olist', maxAge: 600000 });
    res.json({ authorization_url: url });
  });
  app.get('/oauth/olist/callback', async (req, res) => {
    const { code, state } = req.query;
    const cookies = req.headers.cookie?.split(';').map(p => p.trim()) ?? [];
    const binding = cookies.find(p => p.startsWith('olist_oauth_binding='))?.slice('olist_oauth_binding='.length);
    res.clearCookie('olist_oauth_binding', { path: '/oauth/olist', secure: origin.protocol === 'https:', sameSite: 'lax', httpOnly: true });
    if (typeof code !== 'string' || !code.length || code.length > 4096 || typeof state !== 'string' || !/^[\w-]{43}$/.test(state) || !binding || !/^[\w-]{43}$/.test(binding)) { res.status(400).send('Callback OAuth inválido. Inicie a autorização novamente.'); return; }
    try { await oauth.callback(code, state, binding); res.type('text').send('Olist autorizada. Você pode fechar esta janela.'); }
    catch { logger.warn({ event: 'oauth_callback_failed', request_id: res.locals.requestId }); res.status(400).send('Autorização falhou. Inicie novamente.'); }
  });
  // Human approval console. Same admin Bearer as OAuth; never configured in Codex/ChatGPT.
  app.get('/admin', (_req, res) => { res.type('html').send(adminPage); });
  app.get('/admin/admin.js', (_req, res) => { res.type('js').send(adminScript); });
  app.use('/admin/api', auth(config.ADMIN_BEARER_TOKEN), express.json({ limit: '4kb' }));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const adminError = (res: express.Response, error: unknown) => {
    if (error instanceof ChangeError) { res.status(error.code === 'NOT_FOUND' ? 404 : 409).json({ error: `${error.code}: ${error.message}` }); return; }
    logger.warn({ event: 'admin_failed', request_id: res.locals.requestId }); res.status(500).json({ error: 'Falha', request_id: res.locals.requestId });
  };
  app.get('/admin/api/status', (_req, res) => { res.json({ writeMode: config.WRITE_MODE, writeOperations: config.WRITE_OPERATIONS, approvalMode: config.APPROVAL_MODE }); });
  app.get('/admin/api/summary', async (_req, res) => {
    try {
      const rows = (await pool.query(`SELECT CASE WHEN status='pending' AND expires_at<=now() THEN 'expired' ELSE status END AS status, count(*)::int AS n
        FROM change_proposals WHERE account_id=$1 GROUP BY 1`, [config.OLIST_ACCOUNT_ID])).rows as { status: string; n: number }[];
      res.json(Object.fromEntries(rows.map(r => [r.status, r.n])));
    } catch (error) { adminError(res, error); }
  });
  app.get('/admin/api/proposals', async (req, res) => {
    const status = typeof req.query.status === 'string' && /^[a-z]{1,20}$/.test(req.query.status) ? req.query.status : undefined;
    try { res.json(await ops.changes.list({ status, limit: 100 })); } catch (error) { adminError(res, error); }
  });
  app.get('/admin/api/proposals/:id', async (req, res) => {
    if (!uuid.test(req.params.id)) { res.status(400).json({ error: 'id inválido' }); return; }
    try { res.json(await ops.changes.view(req.params.id)); } catch (error) { adminError(res, error); }
  });
  app.post('/admin/api/proposals/:id/approve', async (req, res) => {
    if (!uuid.test(req.params.id)) { res.status(400).json({ error: 'id inválido' }); return; }
    try {
      await ops.changes.approve(req.params.id, 'admin');
      logger.info({ event: 'proposal_approved', proposal_id: req.params.id, request_id: res.locals.requestId });
      res.json(await ops.changes.runById(req.params.id, 40_000));
    } catch (error) { adminError(res, error); }
  });
  app.post('/admin/api/proposals/:id/reject', async (req, res) => {
    if (!uuid.test(req.params.id)) { res.status(400).json({ error: 'id inválido' }); return; }
    try { res.json(await ops.changes.reject(req.params.id, 'admin')); } catch (error) { adminError(res, error); }
  });
  app.get('/admin/api/automations', async (_req, res) => { try { res.json(await listAutomations(pool, config.OLIST_ACCOUNT_ID)); } catch (error) { adminError(res, error); } });
  app.put('/admin/api/automations/:name', async (req, res) => {
    const enabled = req.body?.enabled, interval = req.body?.intervalMinutes;
    if (typeof enabled !== 'boolean' || (interval !== undefined && (!Number.isInteger(interval) || interval < 5 || interval > 10080))) { res.status(400).json({ error: 'enabled (boolean) e intervalMinutes (5–10080) opcionais' }); return; }
    try { await setAutomation(pool, config.OLIST_ACCOUNT_ID, req.params.name, enabled, interval); res.json({ ok: true }); }
    catch (error) { res.status(400).json({ error: error instanceof Error && error.message === 'Automação desconhecida' ? error.message : 'Falha' }); }
  });
  app.use('/mcp', auth(config.MCP_BEARER_TOKEN));
  // Larger body only to allow spreadsheet import (base64 XLSX); every tool still validates its own input size.
  app.post('/mcp', express.json({ limit: '6mb' }), mcpHandler(config, pool, adapter, ops, logger, 'codex'));
  app.all('/mcp', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).json({ error: 'Method not allowed' }); });
  const handler: ErrorRequestHandler = (_error, _req, res, _next) => {
    logger.error({ event: 'request_failed', request_id: res.locals.requestId });
    if (!res.headersSent) res.status(500).json({ error: 'Request failed', request_id: res.locals.requestId });
    else res.end();
  };
  app.use(handler);
  return app;
}

// Endpoint for OpenAI Secure MCP Tunnel (ChatGPT). Loopback only, with its own Bearer injected by tunnel-client,
// and READ tools only: no proposals, confirmations or local writes reachable from ChatGPT.
export function createTunnelApp(config: Config, pool: Pool, adapter: ReadAdapter, logger: Logger, ops: Operations, port: number) {
  const app = express(); app.disable('x-powered-by');
  app.use(helmet());
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  app.use((req, res, next) => {
    const requestId = randomUUID(); res.locals.requestId = requestId; res.setHeader('X-Request-Id', requestId); res.setHeader('Cache-Control', 'no-store');
    // Browsers always send Origin on cross-site POST: rejecting it blocks DNS-rebinding/CSRF from local web pages.
    if (!hosts.has(req.headers.host ?? '') || req.headers.origin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      res.status(403).json({ error: 'Forbidden', request_id: requestId }); return;
    }
    next();
  });
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok', toolset: config.TUNNEL_TOOLSET }); });
  // No OAuth on this channel: answer discovery with JSON 404 so clients treat it as a plain (no-auth) MCP server.
  app.use('/.well-known', (_req, res) => { res.status(404).json({ error: 'not_found' }); });
  app.use('/mcp', (req, res, next) => {
    if (!config.TUNNEL_MCP_BEARER_TOKEN || !authorized(req.headers.authorization, config.TUNNEL_MCP_BEARER_TOKEN)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    next();
  });
  app.post('/mcp', express.json({ limit: config.TUNNEL_TOOLSET === 'prepare' ? '6mb' : '64kb' }), mcpHandler(config, pool, adapter, ops, logger, 'tunnel'));
  app.all('/mcp', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).json({ error: 'Method not allowed' }); });
  const handler: ErrorRequestHandler = (_error, _req, res, _next) => {
    logger.error({ event: 'request_failed', request_id: res.locals.requestId });
    if (!res.headersSent) res.status(500).json({ error: 'Request failed', request_id: res.locals.requestId });
    else res.end();
  };
  app.use(handler);
  return app;
}

function mcpHandler(config: Config, pool: Pool, adapter: ReadAdapter, ops: Operations, logger: Logger, channel: 'codex' | 'tunnel'): RequestHandler {
  return async (req, res) => {
    const server = createMcpServer({ requestId: res.locals.requestId, adapter, ops, readOnly: channel === 'tunnel', allowPrepare: config.TUNNEL_TOOLSET === 'prepare', remember: items => remember(pool, config.OLIST_ACCOUNT_ID, items),
      audit: async (tool, work) => {
        const id = randomUUID(); const started = Date.now();
        await pool.query('INSERT INTO audit_events(id,account_id,tool,request_id,outcome,details) VALUES($1,$2,$3,$4,\'started\',$5)', [id, config.OLIST_ACCOUNT_ID, tool, res.locals.requestId, { canal: channel }]);
        try {
          const result = await work();
          await pool.query("UPDATE audit_events SET outcome='success',duration_ms=$2,finished_at=now() WHERE id=$1", [id, Date.now()-started]);
          logger.info({ event: 'tool_completed', tool, audit_id: id, request_id: res.locals.requestId, duration_ms: Date.now()-started });
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : '';
          const errorCode = error instanceof ChangeError ? error.code : /^Olist HTTP \d{3}/.test(message) ? message.slice(0, 14).replaceAll(' ', '_') :
            message.startsWith('Rate limited') ? 'RATE_LIMITED' : error instanceof Error && error.name === 'ZodError' ? 'SCHEMA_MISMATCH' : 'READ_FAILED';
          await pool.query("UPDATE audit_events SET outcome='error',duration_ms=$2,finished_at=now(),error_code=$3 WHERE id=$1", [id, Date.now()-started, errorCode]);
          logger.warn({ event: 'tool_failed', tool, audit_id: id, request_id: res.locals.requestId, error_code: errorCode }); throw error;
        }
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
