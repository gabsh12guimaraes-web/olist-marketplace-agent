import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/tools.ts';

test('MCP without operations exposes only the 11 original read tools; projections, validation, SKU ambiguity and audit', async () => {
  const calls: string[] = [], audit: string[] = [];
  const server = createMcpServer({
    adapter: { async get(path) { calls.push(path); return path === '/produtos' ? { itens: [{ id: 1, sku: 'A' }, { id: 2, sku: 'A' }], paginacao: { limit: 50, offset: 0, total: 2 } } :
      { id: 1, sku: 'P', observacoes: 'not needed', precos: { preco: 10 }, variacoes: [{ id: 2, sku: 'A', precos: { preco: 20 } }] }; } },
    async remember() {}, async audit(name, work) { audit.push(name); return work(); }
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await server.connect(a); await client.connect(b);
  try {
    const tools = await client.listTools(); assert.equal(tools.tools.length, 11);
    for (const tool of tools.tools) { assert.equal(tool.annotations?.readOnlyHint, true); assert.equal(tool.annotations?.destructiveHint, false); }
    const price = await client.callTool({ name: 'olist_get_prices', arguments: { idProduto: 1, idVariacao: 2 } });
    assert.ok(JSON.stringify(price).includes('20')); assert.deepEqual(calls, ['/produtos/1']);
    const sku = await client.callTool({ name: 'olist_find_sku', arguments: { sku: 'A' } });
    const content = sku.content as { text: string }[];
    assert.equal(JSON.parse(content[0]!.text).correspondenciasExatas.length, 2);
    const invalid = await client.callTool({ name: 'olist_get_product', arguments: { idProduto: '../1' } }); assert.equal(invalid.isError, true);
    const extra = await client.callTool({ name: 'olist_get_product', arguments: { idProduto: 1, url: 'https://evil.test' } }); assert.equal(extra.isError, true);
    const missing = await client.callTool({ name: 'olist_get_variation', arguments: { idProduto: 1, idVariacao: 999 } }); assert.equal(missing.isError, true);
    assert.ok(audit.includes('olist_get_prices'));
  } finally { await client.close(); await server.close(); }
});
test('audit failure prevents upstream read and secret errors never enter MCP output', async () => {
  let called = false;
  const server = createMcpServer({ adapter: { async get() { called = true; return {}; } }, async remember() {}, async audit() { throw new Error('secret-password'); } });
  const [a,b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'test', version: '1' });
  await server.connect(a); await client.connect(b);
  try { const result = await client.callTool({ name: 'olist_get_product', arguments: { idProduto: 1 } }); assert.equal(result.isError, true); assert.equal(called, false); assert.ok(!JSON.stringify(result).includes('secret-password')); }
  finally { await client.close(); await server.close(); }
});
