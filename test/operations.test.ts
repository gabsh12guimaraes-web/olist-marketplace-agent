import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPool, type Pool } from '../src/db.ts';
import type { Config } from '../src/config.ts';
import type { OAuth } from '../src/oauth.ts';
import { OlistHttpError, OlistWriteUnknown } from '../src/adapters/olist.ts';
import { buildOperations } from '../src/app.ts';
import { createMcpServer } from '../src/tools.ts';
import { ChangeError } from '../src/changes.ts';
import { config as baseConfig } from './fixture.ts';

// In-memory Olist double. Writes mutate this state only; nothing reaches the real ERP.
type Dep = { id: number; nome: string; saldo: number; reservado: number; disponivel: number; desconsiderar: boolean };
function fakeOlist() {
  const products: Record<number, any> = {
    340338754: { id: 340338754, sku: 'OVERTULE1', descricao: 'Conjunto Tule', tipoVariacao: 'N', precos: { preco: 65.9, precoPromocional: 0, precoCusto: 20 } },
    100: { id: 100, sku: 'PAI', descricao: 'Pai', tipoVariacao: 'P', precos: { preco: 50 }, variacoes: [{ id: 101, sku: 'PAI-P', precos: { preco: 50, precoPromocional: null } }, { id: 102, sku: 'PAI-M', precos: { preco: 50, precoPromocional: null } }] },
    101: { id: 101, sku: 'PAI-P', tipoVariacao: 'V', produtoPai: { id: 100 }, precos: { preco: 50 } },
    200: { id: 200, sku: 'DUP', tipoVariacao: 'N', precos: { preco: 10 } }, 201: { id: 201, sku: 'DUP', tipoVariacao: 'N', precos: { preco: 10 } },
    300: { id: 300, sku: 'MULTI', tipoVariacao: 'N', precos: { preco: 100, precoPromocional: null } }
  };
  const dep = (id: number, saldo: number, reservado: number): Dep => ({ id, nome: `D${id}`, saldo, reservado, disponivel: saldo - reservado, desconsiderar: false });
  const stock: Record<number, { depositos: Dep[] }> = { 340338754: { depositos: [dep(1, 4, 9)] }, 100: { depositos: [dep(1, 0, 0)] }, 102: { depositos: [dep(1, 1, 1)] }, 200: { depositos: [dep(1, 3, 0)] }, 201: { depositos: [dep(1, 0, 0)] }, 101: { depositos: [dep(1, 3, 0)] }, 300: { depositos: [dep(1, 10, 2), dep(2, 5, 0)] } };
  const stockView = (id: number) => { const d = stock[id]!.depositos; const sum = (k: 'saldo' | 'reservado') => d.reduce((a, x) => a + x[k], 0);
    const sku = products[id]?.sku ?? Object.values(products).flatMap((p: any) => p.variacoes ?? []).find((v: any) => v.id === id)?.sku;
    return { id, codigo: sku, saldo: sum('saldo'), reservado: sum('reservado'), disponivel: sum('saldo') - sum('reservado'), depositos: d }; };
  const writes: { method: string; path: string; body: any }[] = [];
  const images: Record<number, any[]> = { 101: [{ id: 1, url: 'https://cdn.example.com/old.jpg', externo: false }] };
  let failNext: 'unknown' | 'unknown-applied' | null = null, rateLimited = false;
  const adapter = {
    async get(path: string, query: Record<string, any> = {}) {
      if (rateLimited) throw new Error('Rate limited; retry later');
      if (path === '/produtos') { const itens = Object.values(products).filter(p => !query.codigo || p.sku === query.codigo); return { itens, paginacao: { limit: 100, offset: 0, total: itens.length } }; }
      let m = path.match(/^\/produtos\/(\d+)$/); if (m) { if (!products[+m[1]!]) throw new OlistHttpError(404); return structuredClone(products[+m[1]!]); }
      m = path.match(/^\/estoque\/(\d+)$/); if (m) return structuredClone(stockView(+m[1]!));
      m = path.match(/^\/produtos\/(\d+)\/anexos$/); if (m) return structuredClone(images[+m[1]!] ?? []);
      if (path === '/estoque') { const itens = Object.keys(stock).map(id => { const v = stockView(+id); return { idProduto: v.id, sku: v.codigo, saldo: v.saldo, reservado: v.reservado, disponivel: v.disponivel }; }); return { itens, paginacao: { limit: 100, offset: 0, total: itens.length } }; }
      if (path === '/intermediadores') throw new OlistHttpError(403);
      return { itens: [], paginacao: { limit: 1, offset: 0, total: 0 } };
    },
    async send(method: 'POST' | 'PUT' | 'DELETE', path: string, body: any) {
      writes.push({ method, path, body });
      const apply = () => {
        if (method === 'DELETE') {
          const v = path.match(/^\/produtos\/(\d+)\/variacoes\/(\d+)$/);
          if (v) { products[+v[1]!].variacoes = products[+v[1]!].variacoes.filter((x: any) => x.id !== +v[2]!); return null; }
          const p = path.match(/^\/produtos\/(\d+)$/); if (p) { delete products[+p[1]!]; return null; }
        }
        const a = path.match(/^\/produtos\/(\d+)\/anexos$/); if (a) { images[+a[1]!] = [...(images[+a[1]!] ?? []), ...body.map((x: any, i: number) => ({ id: i, ...x }))]; return body; }
        let m = path.match(/^\/estoque\/(\d+)$/); if (m) { const d = stock[+m[1]!]!.depositos.find(x => x.id === body.deposito.id)!; d.saldo = body.quantidade; d.disponivel = d.saldo - d.reservado; return; }
        m = path.match(/^\/produtos\/(\d+)\/preco$/); if (m) { Object.assign(products[+m[1]!].precos, body); return; }
        m = path.match(/^\/produtos\/(\d+)\/variacoes\/(\d+)\/preco$/); if (m) { Object.assign(products[+m[1]!].variacoes.find((v: any) => v.id === +m![2]!).precos, body); return; }
        if (path === '/produtos') { const id = 900 + Object.keys(products).length; products[id] = { id, sku: body.sku, descricao: body.descricao, tipoVariacao: body.tipo === 'V' ? 'P' : 'N', precos: body.precos ?? {} }; return { id }; }
        m = path.match(/^\/produtos\/(\d+)\/variacoes\/(\d+)$/); if (m && method === 'PUT') { Object.assign(products[+m[2]!], body); products[+m[1]!].variacoes.find((v: any) => v.id === +m![2]!).sku = body.sku; return; }
        m = path.match(/^\/produtos\/(\d+)\/variacoes$/); if (m) { const id = 800 + products[+m[1]!].variacoes.length; products[+m[1]!].variacoes.push({ id, sku: body.sku, grade: body.grade }); return { id }; }
        m = path.match(/^\/produtos\/(\d+)$/); if (m) { Object.assign(products[+m[1]!], body); }
      };
      if (failNext === 'unknown') { failNext = null; throw new OlistWriteUnknown('lost'); }
      if (failNext === 'unknown-applied') { failNext = null; apply(); throw new OlistWriteUnknown('lost'); }
      const created = apply(); return created ?? (method === 'POST' ? { idLancamento: 1 } : null);
    }
  };
  return { adapter, products, stock, writes, fail(k: typeof failNext) { failNext = k; }, setRateLimited(v: boolean) { rateLimited = v; } };
}
const oauth = { async status() { return { autorizado: true }; } } as unknown as OAuth;
async function setup(pool: Pool, overrides: Partial<Config> = {}) {
  const account = `test-${randomUUID()}`;
  const config = { ...baseConfig, OLIST_ACCOUNT_ID: account, ...overrides } as Config;
  const olist = fakeOlist();
  return { account, config, olist, ops: buildOperations(config, pool, oauth, olist.adapter) };
}
const enabled = { WRITE_MODE: 'enabled', WRITE_OPERATIONS: ['stock', 'price'] } as Partial<Config>;

test('operations against PostgreSQL with mocked ERP', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  const pool = createPool(process.env.TEST_DATABASE_URL!);
  const accounts: string[] = [];
  const track = async (o: Partial<Config> = {}) => { const s = await setup(pool, o); accounts.push(s.account); return s; };
  try {
    for (const f of ['001_init.sql', '002_operations.sql']) await pool.query(await readFile(new URL(`../db/${f}`, import.meta.url), 'utf8'));
    // Twice: migrations must be re-runnable.
    await pool.query(await readFile(new URL('../db/002_operations.sql', import.meta.url), 'utf8'));

    await t.test('OVERTULE1 (saldo 4, reservado 9, disponível -5): physical below reservation is blocked and data untouched', async () => {
      const { ops, olist } = await track(enabled);
      const p = await ops.changes.create(await planStock(ops, { idProduto: 340338754, quantidade: 3, alvo: 'fisico' }));
      assert.equal(p.status, 'blocked');
      assert.match(p.itens[0]!.message!, /disponível negativo \(-6\)/);
      assert.ok(p.risks.some((r: string) => /disponível atual negativo \(-5\)/.test(r)));
      const d = await ops.changes.create(await planStock(ops, { idProduto: 340338754, quantidade: 0, alvo: 'disponivel' }));
      assert.equal(d.status, 'pending');
      assert.equal(d.itens[0]!.after.quantidade, 9); assert.equal(d.itens[0]!.after.movimentacaoCalculada, 5); assert.equal(d.itens[0]!.after.disponivelResultante, 0);
      assert.deepEqual(d.itens[0]!.before, { saldoTotal: 4, reservadoTotal: 9, disponivelTotal: -5, idDeposito: 1, saldoDeposito: 4, reservadoDeposito: 9, disponivelDeposito: -5 });
      assert.equal(olist.writes.length, 0);
    });

    await t.test('read-only by default: approval refused by the server, nothing written', async () => {
      const { ops, olist } = await track();
      const p = await ops.changes.create(await planStock(ops, { idProduto: 101, quantidade: 7, alvo: 'fisico' }));
      await assert.rejects(ops.changes.approve(p.id, 'admin'), (e: ChangeError) => e.code === 'WRITE_NOT_PERMITTED');
      assert.equal(olist.writes.length, 0);
      const perOp = await track({ WRITE_MODE: 'enabled', WRITE_OPERATIONS: ['price'] } as Partial<Config>);
      const q = await perOp.ops.changes.create(await planStock(perOp.ops, { idProduto: 101, quantidade: 7, alvo: 'fisico' }));
      await assert.rejects(perOp.ops.changes.approve(q.id, 'admin'), (e: ChangeError) => /WRITE_OPERATIONS:stock/.test(e.message));
    });

    await t.test('agent cannot approve in admin mode; human approval executes once, verifies and audits', async () => {
      const { ops, olist, account } = await track(enabled);
      const p = await ops.changes.create(await planStock(ops, { idProduto: 101, quantidade: 7, alvo: 'fisico' }));
      await assert.rejects(ops.changes.approve(p.id, 'client', 'whatever'), (e: ChangeError) => e.code === 'HUMAN_APPROVAL_REQUIRED');
      const again = await ops.changes.create(await planStock(ops, { idProduto: 101, quantidade: 7, alvo: 'fisico' }));
      assert.equal(again.id, p.id); assert.equal(again.duplicada, true);
      await ops.changes.approve(p.id, 'admin');
      await assert.rejects(ops.changes.approve(p.id, 'admin'), (e: ChangeError) => e.code === 'INVALID_STATUS');
      const done = await ops.changes.runById(p.id, 10_000);
      await ops.changes.runById(p.id, 10_000);
      assert.equal(done.status, 'succeeded'); assert.equal(done.itens[0]!.verified, true);
      assert.equal(olist.writes.length, 1);
      assert.deepEqual(olist.writes[0], { method: 'POST', path: '/estoque/101', body: { deposito: { id: 1 }, tipo: 'B', quantidade: 7, precoUnitario: null, observacoes: 'Ajuste via agente MCP' } });
      const audit = await pool.query("SELECT kind,tool,outcome FROM audit_events WHERE account_id=$1 AND proposal_id=$2 ORDER BY created_at", [account, p.id]);
      assert.deepEqual(audit.rows.map(r => r.kind), ['prepare', 'execute', 'execute']);
    });

    await t.test('concurrent change between preview and execution → conflict, no write', async () => {
      const { ops, olist } = await track(enabled);
      const p = await ops.changes.create(await planStock(ops, { idProduto: 101, quantidade: 8, alvo: 'fisico' }));
      olist.stock[101]!.depositos[0]!.saldo = 2; // sale happened
      await ops.changes.approve(p.id, 'admin');
      const done = await ops.changes.runById(p.id, 10_000);
      assert.equal(done.itens[0]!.status, 'conflict'); assert.equal(done.status, 'failed'); assert.equal(olist.writes.length, 0);
    });

    await t.test('expired proposal cannot be approved', async () => {
      const { ops } = await track(enabled);
      const p = await ops.changes.create(await planStock(ops, { idProduto: 101, quantidade: 9, alvo: 'fisico' }));
      await pool.query("UPDATE change_proposals SET expires_at=now()-interval '1 second' WHERE id=$1", [p.id]);
      assert.equal((await ops.changes.view(p.id)).status, 'expired');
      await assert.rejects(ops.changes.approve(p.id, 'admin'), (e: ChangeError) => e.code === 'EXPIRED');
      // The same request can be prepared again instead of returning the expired proposal.
      const again = await ops.changes.create(await planStock(ops, { idProduto: 101, quantidade: 9, alvo: 'fisico' }));
      assert.notEqual(again.id, p.id); assert.equal(again.status, 'pending');
    });

    await t.test('lost response: verified by read, never resent; crash after send resumes by verification only', async () => {
      const { ops, olist } = await track(enabled);
      const a = await ops.changes.create(await planStock(ops, { idProduto: 101, quantidade: 11, alvo: 'fisico' }));
      await ops.changes.approve(a.id, 'admin'); olist.fail('unknown-applied');
      assert.equal((await ops.changes.runById(a.id, 10_000)).itens[0]!.status, 'succeeded');
      const b = await ops.changes.create(await planStock(ops, { idProduto: 101, quantidade: 12, alvo: 'fisico' }));
      await ops.changes.approve(b.id, 'admin'); olist.fail('unknown');
      const r = await ops.changes.runById(b.id, 10_000);
      assert.equal(r.itens[0]!.status, 'unknown'); assert.equal(olist.writes.length, 2);
      const c = await ops.changes.create(await planStock(ops, { idProduto: 101, quantidade: 13, alvo: 'fisico' }));
      await ops.changes.approve(c.id, 'admin');
      await pool.query('UPDATE change_items SET executed_at=now() WHERE proposal_id=$1', [c.id]); // simulated crash after sending
      const resumed = await ops.changes.runById(c.id, 10_000);
      assert.equal(resumed.itens[0]!.status, 'unknown'); assert.equal(olist.writes.length, 2);
    });

    await t.test('multiple deposits require explicit deposit; parent products redirect to variations', async () => {
      const { ops } = await track(enabled);
      const m = await planStock(ops, { idProduto: 300, quantidade: 1, alvo: 'fisico' });
      assert.match(m.items[0]!.message!, /Informe idDeposito: 2/);
      const ok = await planStock(ops, { idProduto: 300, quantidade: 1, alvo: 'disponivel', idDeposito: 1 });
      assert.equal(ok.items[0]!.after.quantidade, 3);
      const parent = await planStock(ops, { idProduto: 100, quantidade: 1, alvo: 'fisico' });
      assert.equal(parent.items[0]!.status, 'invalid'); assert.match(parent.items[0]!.message!, /cada variação \(101, 102\)/);
    });

    await t.test('prices: limit, guard, variation path, percent rule and simulation', async () => {
      const { ops, olist, account } = await track(enabled);
      await pool.query('INSERT INTO price_guards(account_id,olist_product_id,min_price) VALUES($1,300,90)', [account]);
      const p = await ops.changes.create({ kind: 'price', summary: 't', risks: [], request: {}, ...(await priceItems(ops, { itens: [
        { idProduto: 340338754, preco: 200 }, { idProduto: 300, preco: 85 }, { idProduto: 100, idVariacao: 101, preco: 55 }] })) });
      const [high, guarded, variation] = p.itens;
      assert.match(high!.message!, /excede o limite/); assert.match(guarded!.message!, /mínimo/); assert.equal(variation!.status, 'pending');
      await ops.changes.approve(p.id, 'admin'); await ops.changes.runById(p.id, 10_000);
      assert.deepEqual(olist.writes, [{ method: 'PUT', path: '/produtos/100/variacoes/101/preco', body: { preco: 55, precoPromocional: null } }]);
      const pct = await priceItems(ops, { idsProdutos: [340338754], percentual: 5 });
      assert.equal(pct.items[0]!.after.preco, 69.2); assert.equal(pct.items[0]!.after.precoPromocional, 0);
    });

    await t.test('product edit and SKU change are blocked with reasons and procedure', async () => {
      const { ops, olist } = await track({ ...enabled, WRITE_OPERATIONS: ['stock', 'price', 'product', 'sku'] } as Partial<Config>);
      const { planProductEdit, planSkuChange } = await import('../src/planners.ts');
      const e = await ops.changes.create(await planProductEdit(olist.adapter, ops.lookups, ops.limits, { idProduto: 300, alteracoes: { descricao: 'Novo título' } }));
      assert.equal(e.status, 'blocked'); assert.match(e.blocked_reason!, /homologado/);
      const sku = await ops.changes.create(await planSkuChange(olist.adapter, ops.lookups, ops.limits, { idProduto: 300, novoSku: 'DUP' }));
      assert.equal(sku.status, 'blocked'); assert.match(sku.blocked_reason!, /já existe nos IDs 200, 201/);
      assert.ok(sku.risks.some((r: string) => /Procedimento recomendado/.test(r)));
      assert.equal(olist.writes.length, 0);
    });

    await t.test('product creation: validation, duplicate SKU guard, variation grade, execution with verification', async () => {
      const { ops, olist } = await track({ ...enabled, WRITE_OPERATIONS: ['create'] } as Partial<Config>);
      const { planProductCreate, planVariationCreate } = await import('../src/planners.ts');
      const dup = await planProductCreate(olist.adapter, { sku: 'DUP', descricao: 'X', tipo: 'S' });
      assert.match(dup.items[0]!.message!, /já cadastrado.*DUP/);
      const badGrade = await planProductCreate(olist.adapter, { sku: 'NOVO-V', descricao: 'Vestido', tipo: 'V', grade: ['Tamanho', 'Cor'],
        variacoes: [{ sku: 'NOVO-V-P', grade: [{ chave: 'Tamanho', valor: 'P' }] }] });
      assert.match(badGrade.items[0]!.message!, /chaves da grade/);
      // Variation initial stock only sticks when stock control is on (parent and variation).
      const withStock = await planProductCreate(olist.adapter, { sku: 'NOVO-E', descricao: 'Trio', tipo: 'V', grade: ['Tamanho'],
        variacoes: [{ sku: 'NOVO-E-P', estoqueInicial: 5, grade: [{ chave: 'Tamanho', valor: 'P' }] }] });
      assert.deepEqual(withStock.items[0]!.after.estoque, { controlar: true });
      assert.deepEqual((withStock.items[0]!.after.variacoes as { estoque: unknown }[])[0]!.estoque, { controlar: true, inicial: 5 });
      const plan = await planProductCreate(olist.adapter, { sku: 'NOVO1', descricao: 'Saída de praia nova', tipo: 'S', precos: { preco: 79.9 }, imagens: ['https://cdn.example.com/a.jpg'] });
      assert.equal(plan.items[0]!.status, 'pending');
      assert.deepEqual(plan.items[0]!.after.anexos, [{ url: 'https://cdn.example.com/a.jpg', externo: true }]);
      assert.ok(plan.risks.some(r => /NÃO publica anúncios/.test(r)));
      const p = await ops.changes.create(plan);
      await ops.changes.approve(p.id, 'admin');
      const done = await ops.changes.runById(p.id, 10_000);
      assert.equal(done.status, 'succeeded'); assert.equal(done.itens[0]!.verified, true); assert.match(done.itens[0]!.message!, /Criado com ID 9\d\d/);
      assert.deepEqual(olist.writes.map(w => `${w.method} ${w.path}`), ['POST /produtos']);
      // Same SKU again: the planner refuses, and the executor refuses even if the SKU appears after the preview.
      assert.equal((await planProductCreate(olist.adapter, { sku: 'NOVO1', descricao: 'Y', tipo: 'S' })).items[0]!.status, 'invalid');
      const race = await ops.changes.create(await planProductCreate(olist.adapter, { sku: 'NOVO2', descricao: 'Z', tipo: 'S' }));
      olist.products[999] = { id: 999, sku: 'NOVO2', tipoVariacao: 'N' };
      await ops.changes.approve(race.id, 'admin');
      assert.equal((await ops.changes.runById(race.id, 10_000)).itens[0]!.status, 'conflict');
      assert.equal(olist.writes.length, 1);
      const varPlan = await planVariationCreate(olist.adapter, { idProduto: 100, sku: 'PAI-G', grade: [{ chave: 'Tamanho', valor: 'G' }] });
      assert.equal(varPlan.items[0]!.status, 'pending');
      const v = await ops.changes.create(varPlan); await ops.changes.approve(v.id, 'admin');
      assert.equal((await ops.changes.runById(v.id, 10_000)).itens[0]!.verified, true);
      assert.equal((await planVariationCreate(olist.adapter, { idProduto: 300, sku: 'X-1', grade: [{ chave: 'Tamanho', valor: 'P' }] })).items[0]!.status, 'invalid');
    });

    await t.test('variation images: additive POST only, skips existing URLs, idempotent on repeat', async () => {
      const { ops, olist } = await track({ ...enabled, WRITE_OPERATIONS: ['product'] } as Partial<Config>);
      const { planImagesAdd } = await import('../src/planners.ts');
      const plan = await planImagesAdd(olist.adapter, { itens: [{ idProduto: 101, imagens: ['https://cdn.example.com/old.jpg', 'https://cdn.example.com/new.jpg'] }] });
      assert.deepEqual(plan.items[0]!.after, { imagens: ['https://cdn.example.com/new.jpg'] });
      const p = await ops.changes.create(plan); await ops.changes.approve(p.id, 'admin');
      const done = await ops.changes.runById(p.id, 10_000);
      assert.equal(done.itens[0]!.verified, true);
      assert.deepEqual(olist.writes, [{ method: 'POST', path: '/produtos/101/anexos', body: [{ url: 'https://cdn.example.com/new.jpg', externo: true }] }]);
      assert.equal((await planImagesAdd(olist.adapter, { itens: [{ idProduto: 101, imagens: ['https://cdn.example.com/new.jpg'] }] })).items[0]!.status, 'skipped');
    });

    await t.test('deletion: permission, reservations, parent confirmation, linked listings, limit, execution and verification', async () => {
      const noDelete = await track(enabled);
      const { planDelete, deleteRequest } = await import('../src/planners.ts');
      const p0 = await noDelete.ops.changes.create(await planDelete(noDelete.olist.adapter, noDelete.ops.lookups, { itens: [{ idProduto: 201, incluirVariacoes: false, excluirImagens: true }], motivo: 'teste' }));
      await assert.rejects(noDelete.ops.changes.approve(p0.id, 'admin'), (e: ChangeError) => /WRITE_OPERATIONS:delete/.test(e.message));
      const { ops, olist, account } = await track({ ...enabled, WRITE_OPERATIONS: ['delete'] } as Partial<Config>);
      const plan = (itens: any[]) => planDelete(olist.adapter, ops.lookups, { itens: itens.map(i => ({ incluirVariacoes: false, excluirImagens: true, ...i })), motivo: 'limpeza de teste' });
      assert.match((await plan([{ idProduto: 100, idVariacao: 102 }])).items[0]!.message!, /1 unidade\(s\) reservada/);
      assert.match((await plan([{ idProduto: 100 }])).items[0]!.message!, /incluirVariacoes=true/);
      assert.equal((await plan([{ idProduto: 100, incluirVariacoes: true }])).items[0]!.status, 'invalid'); // variation 102 has a reservation
      assert.match((await plan([{ idProduto: 101 }])).items[0]!.message!, /é uma variação/);
      await pool.query(`INSERT INTO channel_listings(id,account_id,olist_product_id,provider,listing_id) VALUES($1,$2,201,'shopee','L1')`, [randomUUID(), account]);
      assert.match((await plan([{ idProduto: 201 }])).items[0]!.message!, /anúncio\(s\) vinculado/);
      assert.equal(deleteRequest.safeParse({ itens: Array.from({ length: 6 }, (_, i) => ({ idProduto: i + 1 })), motivo: 'massa' }).success, false);
      const simple = await plan([{ idProduto: 200 }]);
      assert.equal(simple.items[0]!.status, 'pending'); assert.ok(simple.risks.some(r => /IRREVERSÍVEL/.test(r)) && simple.risks.some(r => /3 unidade/.test(r)));
      assert.equal((simple.items[0]!.before as { sku: string }).sku, 'DUP');
      const p = await ops.changes.create(simple); await ops.changes.approve(p.id, 'admin');
      const done = await ops.changes.runById(p.id, 10_000);
      assert.equal(done.itens[0]!.status, 'succeeded'); assert.equal(done.itens[0]!.verified, true);
      assert.deepEqual(olist.writes, [{ method: 'DELETE', path: '/produtos/200', body: { excluirAnexosVinculados: true } }]);
      const variation = await ops.changes.create(await plan([{ idProduto: 100, idVariacao: 101 }]));
      await ops.changes.approve(variation.id, 'admin');
      assert.equal((await ops.changes.runById(variation.id, 10_000)).itens[0]!.verified, true);
      assert.deepEqual(olist.writes[1], { method: 'DELETE', path: '/produtos/100/variacoes/101', body: undefined });
      // Stock unreadable → blocked, never deleted without the reservation check.
      assert.match((await plan([{ idProduto: 300 }])).items[0]!.message!, /reservada/);
      olist.products[777] = { id: 777, sku: 'SEM-ESTOQUE', tipoVariacao: 'N', precos: {} };
      assert.match((await plan([{ idProduto: 777 }])).items[0]!.message!, /bloqueada por segurança/);
    });

    await t.test('homologation product allows full PUT edit only on the designated test product', async () => {
      const { ops, olist } = await track({ ...enabled, WRITE_OPERATIONS: ['product'], HOMOLOGATION_PRODUCT_IDS: [300] } as Partial<Config>);
      const { planProductEdit } = await import('../src/planners.ts');
      const other = await planProductEdit(olist.adapter, ops.lookups, ops.limits, { idProduto: 200, alteracoes: { descricao: 'Novo' } });
      assert.match(other.blocked!, /não foi homologado/);
      const test = await ops.changes.create(await planProductEdit(olist.adapter, ops.lookups, ops.limits, { idProduto: 300, alteracoes: { descricao: 'Título homologação' } }));
      assert.equal(test.status, 'pending'); assert.ok(test.risks.some((r: string) => /HOMOLOGAÇÃO/.test(r)));
      await ops.changes.approve(test.id, 'admin');
      const done = await ops.changes.runById(test.id, 10_000);
      assert.equal(done.itens[0]!.status, 'succeeded');
      assert.deepEqual(olist.writes[0], { method: 'PUT', path: '/produtos/300', body: { sku: 'MULTI', descricao: 'Título homologação', precos: { preco: 100, precoPromocional: null }, dimensoes: {} } });
      const { productPutBody, preservedDrift } = await import('../src/changes.ts');
      const raw = { id: 1, sku: 'A', descricao: 'Velho', ncm: '6112.49.00', origem: '0', marca: { id: 9, nome: 'M' }, categoria: { id: 7, nome: 'C' }, gtin: '',
        precos: { preco: 10, precoPromocional: 0, precoCusto: 2, precoCustoMedio: 2 }, dimensoes: { embalagem: { id: null, tipo: 2 }, largura: 15, pesoBruto: 0.15, quantidadeVolumes: 0 },
        seo: { titulo: '', keywords: [], slug: 'a' }, situacao: 'A', variacoes: [{ id: 2 }], anexos: [{ id: 3 }] };
      const body = productPutBody(raw);
      assert.deepEqual(body.marca, { id: 9 }); assert.deepEqual(body.categoria, { id: 7 }); assert.equal(body.ncm, '6112.49.00'); assert.equal(body.origem, 0);
      assert.equal(body.situacao, undefined); assert.equal(body.variacoes, undefined); assert.equal((body.dimensoes as { pesoBruto: number }).pesoBruto, 0.15);
      assert.deepEqual(preservedDrift(raw, { ...raw, descricao: 'Novo' }, ['descricao']), []);
      assert.deepEqual(preservedDrift(raw, { ...raw, descricao: 'Novo', ncm: '', variacoes: [] }, ['descricao']), ['ncm', 'variacoes']);
    });

    await t.test('SKU change on a variation is sent through its parent, never PUT /produtos/{idVariacao}', async () => {
      const { ops, olist } = await track({ ...enabled, WRITE_OPERATIONS: ['sku'], HOMOLOGATION_PRODUCT_IDS: [101] } as Partial<Config>);
      const { planSkuChange } = await import('../src/planners.ts');
      const p = await ops.changes.create(await planSkuChange(olist.adapter, ops.lookups, ops.limits, { idProduto: 101, novoSku: 'PAI-NOVO-P' }));
      await ops.changes.approve(p.id, 'admin');
      const done = await ops.changes.runById(p.id, 10_000);
      assert.equal(done.itens[0]!.status, 'succeeded'); assert.equal(done.itens[0]!.verified, true);
      assert.deepEqual(olist.writes, [{ method: 'PUT', path: '/produtos/100/variacoes/101', body: { sku: 'PAI-NOVO-P', precos: { preco: 50 }, dimensoes: {} } }]);
      // Variation without a parent reference: nothing is sent.
      olist.products[101].produtoPai = null; olist.products[101].sku = 'PAI-P';
      const q = await ops.changes.create(await planSkuChange(olist.adapter, ops.lookups, ops.limits, { idProduto: 101, novoSku: 'PAI-NOVO-P2' }));
      await ops.changes.approve(q.id, 'admin');
      assert.match((await ops.changes.runById(q.id, 10_000)).itens[0]!.message!, /sem produto pai/);
      assert.equal(olist.writes.length, 1);
    });

    await t.test('batch CSV: per-row validation, duplicates, deletions, channel rows, background preparation and rate-limit retry', async () => {
      const { ops, olist, account } = await track(enabled);
      const csv = 'SKU;Estoque;Alvo;Preço;Marketplace;Alteração\nDUP;5;fisico;;;\nNAOEXISTE;5;fisico;;;\nPAI-P;9;fisico;;;\nPAI-P;10;fisico;;;\nOVERTULE1;;;66,90;;\n;;;;Shopee;\nMULTI;;;;;excluir\nOVERTULE1;1;;;;\n';
      const client = await mcpClient(ops, olist.adapter);
      const res = await client.callTool({ name: 'batch_import', arguments: { nomeArquivo: 'lote.csv', conteudoTexto: csv } });
      const created = JSON.parse((res.content as { text: string }[])[0]!.text);
      assert.equal(created.status, 'preparing'); assert.equal(created.linhas, 8);
      olist.setRateLimited(true);
      await ops.changes.runNext(5_000);
      assert.equal((await ops.changes.view(created.id)).status, 'preparing');
      olist.setRateLimited(false);
      await pool.query('UPDATE change_proposals SET lease_until=NULL WHERE id=$1', [created.id]);
      await ops.changes.runNext(5_000);
      const view = await ops.changes.view(created.id);
      const messages = view.itens.map(i => `${i.target.linha}:${i.status}:${i.message ?? ''}`);
      assert.match(messages[0]!, /^2:invalid:SKU duplicado/); assert.match(messages[1]!, /^3:invalid:SKU não encontrado/);
      assert.match(messages[2]!, /^4:pending/); assert.match(messages[3]!, /^5:invalid:.*repetido/);
      assert.match(messages[4]!, /^6:pending/); assert.match(messages[5]!, /^7:skipped:Escrita direta/);
      assert.match(messages[6]!, /^8:invalid:Exclusões/); assert.match(messages[7]!, /^9:invalid:Informe alvo/);
      assert.equal(view.status, 'pending'); assert.equal(olist.writes.length, 0);
      await client.close();
      assert.ok((await pool.query("SELECT 1 FROM audit_events WHERE account_id=$1 AND tool='batch_import'", [account])).rowCount);
    });

    await t.test('batch SKU change: open orders skipped, duplicates refused, variation written through its parent', async () => {
      const { ops, olist } = await track({ ...enabled, WRITE_OPERATIONS: ['sku'], OLIST_PRODUCT_PUT_VERIFIED: true } as Partial<Config>);
      const csv = 'idProduto;SKU novo (proposto)\n101;PAI-NOVO-P\n340338754;TULE-NOVO\n300;DUP\n200;PAI-NOVO-P\n300;SKU COM ESPACO\n';
      const client = await mcpClient(ops, olist.adapter);
      const res = await client.callTool({ name: 'batch_import', arguments: { nomeArquivo: 'skus.csv', conteudoTexto: csv } });
      const created = JSON.parse((res.content as { text: string }[])[0]!.text);
      await ops.changes.runNext(5_000);
      const view = await ops.changes.view(created.id);
      const messages = view.itens.map(i => `${i.target.linha}:${i.operation}:${i.status}:${i.message ?? ''}`);
      assert.match(messages[0]!, /^2:sku_update:pending/);
      assert.match(messages[1]!, /^3:sku_update:skipped:9 unidade\(s\) reservada/);
      assert.match(messages[2]!, /^4:sku_update:invalid:O SKU DUP já existe nos IDs 200, 201/);
      assert.match(messages[3]!, /^5:sku_update:invalid:SKU novo PAI-NOVO-P repetido/);
      assert.match(messages[4]!, /^6:sku_update:invalid:SKU novo inválido/);
      assert.equal(view.status, 'pending'); assert.equal(olist.writes.length, 0);
      await ops.changes.approve(created.id, 'admin');
      const done = await ops.changes.runById(created.id, 10_000);
      assert.equal(done.itens[0]!.status, 'succeeded'); assert.equal(done.itens[0]!.verified, true);
      assert.deepEqual(olist.writes.map(w => `${w.method} ${w.path} ${w.body.sku}`), ['PUT /produtos/100/variacoes/101 PAI-NOVO-P']);
      await client.close();
    });

    await t.test('MCP: confirm in admin mode never executes; revert prepares restoring previous values; diagnostics classify 403', async () => {
      const { ops, olist } = await track(enabled);
      const client = await mcpClient(ops, olist.adapter);
      const call = async (name: string, args: Record<string, unknown>) => { const r = await client.callTool({ name, arguments: args }); return { error: r.isError, data: (r.content as { text: string }[])[0]!.text }; };
      const prep = JSON.parse((await call('change_prepare_price', { itens: [{ idProduto: 300, preco: 110 }] })).data);
      const confirmed = JSON.parse((await call('change_confirm', { proposalId: prep.id, codigoConfirmacao: 'x' })).data);
      assert.equal(confirmed.status, 'pending'); assert.match(confirmed.proximoPasso, /aprovação humana/); assert.equal(olist.writes.length, 0);
      await ops.changes.approve(prep.id, 'admin');
      const executed = JSON.parse((await call('change_confirm', { proposalId: prep.id })).data);
      assert.equal(executed.status, 'succeeded'); assert.equal(olist.products[300].precos.preco, 110);
      const revert = JSON.parse((await call('change_prepare_revert', { proposalId: prep.id })).data);
      assert.equal(revert.itens[0].after.preco, 100);
      const diag = JSON.parse((await call('diagnose_connections', {})).data);
      const inter = diag.olist.modulos.find((m: { modulo: string }) => m.modulo === 'Intermediadores');
      assert.equal(inter.status, 'HTTP_403'); assert.match(inter.correcao, /Leitura ao módulo/);
      const blocked = await call('olist_list_intermediaries', {});
      assert.equal(blocked.error, true); assert.match(blocked.data, /Permissão negada/);
      const stock = JSON.parse((await call('diagnose_stock', {})).data);
      assert.deepEqual(stock.negativos.map((n: { sku: string }) => n.sku), ['OVERTULE1']);
      await client.close();
    });
  } finally {
    for (const account of accounts) for (const table of ['change_proposals', 'audit_events', 'channel_listings', 'price_guards', 'automations', 'id_mappings', 'rate_slots'])
      await pool.query(`DELETE FROM ${table} WHERE account_id=$1`, [account]);
    await pool.end();
  }
});

async function planStock(ops: ReturnType<typeof buildOperations>, req: { idProduto: number; quantidade: number; alvo: 'fisico' | 'disponivel'; idDeposito?: number }) {
  const { planStockItem } = await import('../src/planners.ts');
  const { item, risks } = await planStockItem((ops.changes.d.reader), { permitirDisponivelNegativo: false, ...req });
  return { kind: 'stock' as const, summary: 'teste', risks, items: [item], request: req };
}
async function priceItems(ops: ReturnType<typeof buildOperations>, req: any) {
  const { planPriceItems } = await import('../src/planners.ts');
  return planPriceItems(ops.changes.d.reader, ops.lookups, ops.limits, { aceitarVariacaoAlta: false, ...req });
}
async function mcpClient(ops: ReturnType<typeof buildOperations>, adapter: any) {
  const { remember } = await import('../src/db.ts');
  const server = createMcpServer({ adapter, ops, remember: items => remember(ops.pool, ops.account, items), async audit(tool, work) {
    await ops.pool.query("INSERT INTO audit_events(id,account_id,tool,request_id,outcome,finished_at) VALUES($1,$2,$3,$4,'success',now())", [randomUUID(), ops.account, tool, randomUUID()]);
    return work(); } });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'test', version: '1' });
  await server.connect(a); await client.connect(b);
  return client;
}
