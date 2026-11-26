import pino from 'pino';
import { loadConfig } from './config.ts';
import { createPool } from './db.ts';
import { OAuth } from './oauth.ts';
import { PgReadLimiter } from './rate-limit.ts';
import { OlistAdapter } from './adapters/olist.ts';
import { buildOperations, createApp, createTunnelApp } from './app.ts';
import { runDueAutomations, seedAutomations } from './automations.ts';
const config = loadConfig();
const logger = pino({ level: 'info', redact: { paths: ['authorization', 'cookie', 'code', 'state', 'access_token', 'refresh_token', 'client_secret', 'password'], censor: '[REDACTED]' } });
const pool = createPool(config.DATABASE_URL);
pool.on('error', () => logger.error({ event: 'database_pool_error' }));
await pool.query('SELECT 1 FROM oauth_tokens LIMIT 1');
try { await pool.query('SELECT 1 FROM change_proposals LIMIT 1'); }
catch { throw new Error('Schema desatualizado: execute a migração (pnpm migrate / scripts/local.ps1 -Action Migrate)'); }
const oauth = new OAuth(pool, config);
const adapter = new OlistAdapter(oauth, new PgReadLimiter(pool, config.OLIST_ACCOUNT_ID, config.OLIST_READ_RPM));
const ops = buildOperations(config, pool, oauth, adapter);
await seedAutomations(pool, config.OLIST_ACCOUNT_ID);
const app = createApp(config, pool, oauth, adapter, logger, ops);
const server = app.listen(config.PORT, config.HOST, () => logger.info({ event: 'server_started', port: config.PORT, write_mode: config.WRITE_MODE, approval_mode: config.APPROVAL_MODE }));
server.requestTimeout = 60000; server.headersTimeout = 10000;
// Always bound to 127.0.0.1 regardless of HOST: only the local tunnel-client may reach it.
const tunnel = config.TUNNEL_MCP_PORT ? createTunnelApp(config, pool, adapter, logger, ops, config.TUNNEL_MCP_PORT)
  .listen(config.TUNNEL_MCP_PORT, '127.0.0.1', () => logger.info({ event: 'tunnel_endpoint_started', port: config.TUNNEL_MCP_PORT, toolset: config.TUNNEL_TOOLSET })) : undefined;
if (tunnel) { tunnel.requestTimeout = 110000; tunnel.headersTimeout = 10000; }
// Background worker: batch validation, resumption of interrupted executions and enabled report automations.
let ticking = false, keepAliveAfter = 0;
const worker = setInterval(async () => {
  if (ticking) return; ticking = true;
  try {
    if (Date.now() >= keepAliveAfter) {
      const kept = await oauth.keepAlive().catch(() => 'failed');
      if (kept === 'refreshed') logger.info({ event: 'oauth_kept_alive' });
      // Back off after a failure: a rejected refresh token won't recover by retrying every tick.
      else if (kept === 'failed') { keepAliveAfter = Date.now() + 30 * 60_000; logger.warn({ event: 'oauth_keepalive_failed', action: 'reauthorize at /oauth/olist/connect' }); }
    }
    for (let i = 0; i < 5 && await ops.changes.runNext(30_000); i++);
    const ran = await runDueAutomations({ pool, reader: adapter, account: config.OLIST_ACCOUNT_ID, tokenStatus: () => oauth.status(), marketplaces: ops.marketplaces });
    if (Object.keys(ran).length) logger.info({ event: 'automations_ran', names: Object.keys(ran) });
  } catch { logger.warn({ event: 'worker_tick_failed' }); }
  finally { ticking = false; }
}, config.AUTOMATIONS_TICK_SECONDS * 1000);
worker.unref();
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true; clearInterval(worker); tunnel?.close();
  const deadline = setTimeout(() => { server.closeAllConnections(); process.exit(1); }, 15000); deadline.unref();
  server.close(async () => { await pool.end(); clearTimeout(deadline); process.exit(0); });
}
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
