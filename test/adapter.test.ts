import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OlistAdapter, OlistWriteUnknown, API_BASE } from '../src/adapters/olist.ts';
import { marketplaceStatus } from '../src/adapters/marketplaces.ts';
import { config } from './fixture.ts';
import type { ReadLimiter } from '../src/rate-limit.ts';
const limiter: ReadLimiter = { async acquire() {}, async observe() {} };
test('fixed official API host, GET only, query encoded and no arbitrary paths', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const adapter = new OlistAdapter({ async accessToken() { return 'test'; } }, limiter, async (url, init) => {
    calls.push({ url: String(url), init }); return Response.json({ itens: [] });
  });
  await adapter.get('/produtos', { codigo: 'A&B', limit: 20, offset: 40 });
  assert.equal(new URL(calls[0]!.url).searchParams.get('codigo'), 'A&B');
  assert.equal(calls[0]!.init?.method, 'GET');
  assert.equal(calls[0]!.init?.redirect, 'error');
  assert.equal(new URL(calls[0]!.url).origin, new URL(API_BASE).origin);
  for (const path of ['/produtos/1/preco', '/produtos/1/variacoes', 'https://evil.test', '/produtos/../pedidos', '/produtos/0']) await assert.rejects(adapter.get(path));
  assert.equal(calls.length, 1);
});
test('401 refreshes once with invalid token and retries GET', async () => {
  const invalid: (string | undefined)[] = []; let requests = 0;
  const adapter = new OlistAdapter({ async accessToken(token) { invalid.push(token); return token ? 'new' : 'old'; } }, limiter,
    async () => ++requests === 1 ? new Response('', { status: 401 }) : Response.json({ id: 1 }));
  assert.deepEqual(await adapter.get('/produtos/1'), { id: 1 });
  assert.deepEqual(invalid, [undefined, 'old']);
});
test('429 observes cooldown, returns sanitized status and does not retry storm', async () => {
  let count = 0, observed = 0;
  const adapter = new OlistAdapter({ async accessToken() { return 'test'; } }, { async acquire() {}, async observe(_h, status) { observed = status; } },
    async () => { count++; return new Response('sensitive upstream body', { status: 429 }); });
  await assert.rejects(adapter.get('/estoque'), e => e instanceof Error && e.message === 'Olist HTTP 429; retry later');
  assert.equal(count, 1); assert.equal(observed, 429);
});
test('all supported routes exist as GET in downloaded official contract', async () => {
  const spec = JSON.parse(await readFile(new URL('../docs/olist-openapi.json', import.meta.url), 'utf8'));
  assert.equal(spec.servers[0].url, API_BASE);
  for (const path of ['/produtos', '/produtos/{idProduto}', '/estoque', '/estoque/{idProduto}', '/listas-precos', '/listas-precos/{idListaDePreco}']) assert.ok(spec.paths[path].get);
  assert.equal(spec.paths['/produtos/{idProduto}/preco'].get, undefined);
  assert.equal(spec.paths['/produtos/{idProduto}/variacoes'].get, undefined);
});
test('marketplace adapters never advertise unvalidated capabilities, even with credentials configured', () => {
  for (const cfg of [config, { ...config, ML_CLIENT_ID: 'x', ML_CLIENT_SECRET: 'y', SHOPEE_PARTNER_ID: '1', SHOPEE_PARTNER_KEY: 'k' }]) {
    const list = marketplaceStatus(cfg);
    assert.equal(list.length, 5);
    for (const adapter of list) { assert.notEqual(adapter.status, 'implemented'); assert.deepEqual(adapter.capabilities, []); assert.ok(adapter.blockers.length > 0); }
  }
});
test('writes: only documented endpoints, never DELETE, 401 retried once, 5xx/timeout reported as unknown without resend', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let mode: 'ok' | '500' | 'throw' | '401' = 'ok';
  const adapter = new OlistAdapter({ async accessToken(t) { return t ? 'new' : 'old'; } }, limiter, async (url, init) => {
    calls.push({ url: String(url), init });
    if (mode === '500') return new Response('upstream secret', { status: 500 });
    if (mode === 'throw') throw new Error('socket');
    if (mode === '401' && calls.length === 1) return new Response('', { status: 401 });
    return Response.json({ idLancamento: 9 });
  });
  assert.deepEqual(await adapter.send('POST', '/estoque/1', { tipo: 'B', quantidade: 2 }), { idLancamento: 9 });
  assert.equal(calls[0]!.init?.method, 'POST'); assert.equal(calls[0]!.init?.redirect, 'error');
  for (const [method, path] of [['PUT', '/estoque/1'], ['PUT', '/produtos'], ['PUT', '/pedidos/1'], ['POST', '/pedidos'], ['PUT', '/produtos/1/anexos'], ['PUT', '/produtos/0/preco'], ['PUT', 'https://evil.test']] as const)
    await assert.rejects(adapter.send(method, path, {}), /not allowed/);
  // DELETE only for one product or one variation; never orders, attachments, collections or nested paths.
  for (const path of ['/pedidos/1', '/produtos/1/anexos', '/produtos', '/notas/1', '/produtos/1/tags', '/listas-precos/1/produtos/2'])
    await assert.rejects(adapter.send('DELETE', path, undefined), /not allowed/);
  calls.length = 0;
  await adapter.send('DELETE', '/produtos/1/variacoes/2', undefined);
  assert.equal(calls[0]!.init?.method, 'DELETE'); assert.equal(calls[0]!.init?.body, undefined);
  calls.length = 0; mode = '500';
  await assert.rejects(adapter.send('PUT', '/produtos/1/preco', { preco: 1 }), e => e instanceof OlistWriteUnknown && !e.message.includes('secret'));
  assert.equal(calls.length, 1);
  calls.length = 0; mode = 'throw';
  await assert.rejects(adapter.send('POST', '/estoque/1', {}), OlistWriteUnknown); assert.equal(calls.length, 1);
  calls.length = 0; mode = '401';
  await adapter.send('PUT', '/produtos/1/variacoes/2/preco', { preco: 1 }); assert.equal(calls.length, 2);
  assert.equal((calls[1]!.init?.headers as Record<string, string>).Authorization, 'Bearer new');
});
test('all write routes exist with the same method in the official contract', async () => {
  const spec = JSON.parse(await readFile(new URL('../docs/olist-openapi.json', import.meta.url), 'utf8'));
  for (const [method, path] of [['post', '/estoque/{idProduto}'], ['put', '/produtos/{idProduto}/preco'], ['put', '/produtos/{idProduto}/variacoes/{idVariacao}/preco'], ['put', '/produtos/{idProduto}'], ['post', '/produtos'], ['post', '/produtos/{idProduto}/variacoes'], ['delete', '/produtos/{idProduto}'], ['delete', '/produtos/{idProduto}/variacoes/{idVariacao}']])
    assert.ok(spec.paths[path][method], `${method} ${path}`);
  for (const path of ['/depositos', '/categorias/todas', '/marcas', '/intermediadores', '/estoque/{idProduto}/logs-movimentacao', '/produtos/{idProduto}/logs-alteracao', '/pedidos'])
    assert.ok(spec.paths[path].get, path);
});
