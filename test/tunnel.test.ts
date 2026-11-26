import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import pino from 'pino';
import type { Pool } from '../src/db.ts';
import type { OAuth } from '../src/oauth.ts';
import { buildOperations, createTunnelApp } from '../src/app.ts';
import { config } from './fixture.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/tools.ts';

test('ChatGPT channel in prepare mode: can prepare and cancel, never confirm or link', async () => {
  const pool = { async query() { return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const adapter = { async get() { return {}; } };
  const ops = buildOperations(config, pool, {} as OAuth, adapter);
  const server = createMcpServer({ adapter, ops, readOnly: true, allowPrepare: true, async remember() {}, async audit(_n, w) { return w(); } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 't', version: '1' });
  await server.connect(a); await client.connect(b);
  try {
    const names = (await client.listTools()).tools.map(t => t.name);
    for (const n of ['change_prepare_stock', 'change_prepare_price', 'change_prepare_product', 'change_prepare_sku', 'change_prepare_create_product', 'change_prepare_create_variation', 'batch_import', 'change_cancel', 'change_get'])
      assert.ok(names.includes(n), n);
    for (const n of ['change_confirm', 'mapping_link']) assert.ok(!names.includes(n), n);
  } finally { await client.close(); await server.close(); }
});

test('ChatGPT tunnel endpoint: loopback, own Bearer, read-only tools, rejects Origin and foreign Host', async () => {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const adapter = { async get() { return {}; } };
  const pool = { async query() { return { rows: [], rowCount: 0 }; } } as unknown as Pool;
  const cfg = { ...config, TUNNEL_MCP_BEARER_TOKEN: 't'.repeat(40) };
  const ops = buildOperations(cfg, pool, {} as OAuth, adapter);
  server.on('request', createTunnelApp(cfg, pool, adapter, pino({ enabled: false }), ops, address.port));
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${'t'.repeat(40)}` };
  const rpc = (method: string, extra: Record<string, string> = {}) => fetch(`${url}/mcp`, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) });
  try {
    const listed = await rpc('tools/list');
    assert.equal(listed.status, 200);
    const tools = (await listed.json()).result.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    assert.ok(tools.length >= 25);
    assert.ok(tools.every(t => t.annotations.readOnlyHint));
    for (const name of ['change_confirm', 'change_prepare_stock', 'change_prepare_price', 'batch_import', 'mapping_link', 'change_cancel'])
      assert.equal(tools.some(t => t.name === name), false, name);
    assert.ok(tools.some(t => t.name === 'stock_overview'));
    assert.equal((await rpc('tools/list', { origin: 'https://evil.test' })).status, 403);
    for (const authorization of ['', `Bearer ${config.MCP_BEARER_TOKEN}`, `Bearer ${config.ADMIN_BEARER_TOKEN}`]) assert.equal((await rpc('tools/list', { authorization })).status, 401);
    const badHost = await new Promise(resolve => { const req = request(`${url}/mcp`, { method: 'POST', headers: { host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode); }); req.end(); });
    assert.equal(badHost, 403);
    assert.equal((await fetch(`${url}/admin`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
