import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import pino from 'pino';
import type { Pool } from '../src/db.ts';
import type { OAuth } from '../src/oauth.ts';
import { createApp } from '../src/app.ts';
import { config } from './fixture.ts';
test('Streamable HTTP initialize/list, auth, host/origin and callback validation', async () => {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  let starts = 0;
  const oauth = { async start() { starts++; return { url: 'https://example.test/auth', binding: 'test-binding' }; } } as unknown as OAuth;
  const app = createApp({ ...config, PUBLIC_URL: url }, {} as Pool, oauth, { async get() { throw new Error('unused'); } }, pino({ enabled: false }));
  server.on('request', app);
  const headers = { authorization: `Bearer ${config.MCP_BEARER_TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  try {
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, origin: 'https://evil.test' } })).status, 403);
    const badHost = await new Promise(resolve => { const req = request(`${url}/mcp`, { method: 'POST', headers: { host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); });
    assert.equal(badHost, 403);
    const initialized = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }) });
    assert.equal(initialized.status, 200); assert.ok((await initialized.json()).result.capabilities.tools);
    const listed = await fetch(`${url}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    const tools = (await listed.json()).result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }[];
    for (const name of ['olist_list_products', 'olist_get_product', 'olist_list_skus', 'olist_find_sku', 'olist_list_variations', 'olist_get_variation', 'olist_get_prices', 'olist_list_stock', 'olist_get_stock', 'olist_list_price_lists', 'olist_get_price_list'])
      assert.equal(tools.find(t => t.name === name)?.annotations.readOnlyHint, true, name);
    assert.equal(tools.find(t => t.name === 'change_confirm')?.annotations.destructiveHint, true);
    assert.ok(tools.filter(t => !t.annotations.readOnlyHint).every(t => /^(change_|batch_import|mapping_link)/.test(t.name)));
    // Admin console API: admin Bearer only; the MCP Bearer must not approve anything.
    assert.equal((await fetch(`${url}/admin/api/status`, { headers })).status, 401);
    assert.equal((await fetch(`${url}/admin/api/proposals/00000000-0000-0000-0000-000000000000/approve`, { method: 'POST', headers })).status, 401);
    const status = await fetch(`${url}/admin/api/status`, { headers: { ...headers, authorization: `Bearer ${config.ADMIN_BEARER_TOKEN}` } });
    assert.deepEqual(await status.json(), { writeMode: 'disabled', writeOperations: [], approvalMode: 'admin' });
    assert.ok(!(await (await fetch(`${url}/admin`)).text()).includes(config.ADMIN_BEARER_TOKEN));
    assert.equal((await fetch(`${url}/mcp`, { headers })).status, 405);
    assert.equal((await fetch(`${url}/oauth/olist/start`, { method: 'POST', headers })).status, 401);
    const adminHeaders = { ...headers, authorization: `Bearer ${config.ADMIN_BEARER_TOKEN}` };
    for (const body of [{}, { registered_redirect_uri: config.OLIST_REDIRECT_URI + '/' }]) {
      assert.equal((await fetch(`${url}/oauth/olist/start`, { method: 'POST', headers: adminHeaders, body: JSON.stringify(body) })).status, 400);
    }
    assert.equal(starts, 0);
    const started = await fetch(`${url}/oauth/olist/start`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ registered_redirect_uri: config.OLIST_REDIRECT_URI }) });
    assert.equal(started.status, 200); assert.equal(starts, 1);
    assert.match(started.headers.get('set-cookie')!, /HttpOnly/);
    assert.match(started.headers.get('set-cookie')!, /SameSite=Lax/);
    const page = await fetch(`${url}/oauth/olist/connect`);
    assert.equal(page.status, 200);
    assert.ok(!(await page.text()).includes(config.ADMIN_BEARER_TOKEN));
    assert.ok(!page.headers.get('content-security-policy')?.includes('upgrade-insecure-requests'));
    assert.equal((await fetch(`${url}/oauth/olist/callback?code=test&state=bad`)).status, 400);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
