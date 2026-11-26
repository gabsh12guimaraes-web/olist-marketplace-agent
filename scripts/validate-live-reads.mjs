import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { OAuth } from '../src/oauth.ts';
import { PgReadLimiter } from '../src/rate-limit.ts';
import { OlistAdapter } from '../src/adapters/olist.ts';
import * as schemas from '../src/schemas.ts';
const report = { at: new Date().toISOString(), tools: [], checks: [], errors: [] };
let pool, client;
try {
  const c = loadConfig(parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')));
  pool = createPool(c.DATABASE_URL);
  const adapter = new OlistAdapter(new OAuth(pool, c), new PgReadLimiter(pool, c.OLIST_ACCOUNT_ID, c.OLIST_READ_RPM));
  client = new Client({ name: 'olist-live-read-validation', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', c.PUBLIC_URL), { requestInit: { headers: { Authorization: `Bearer ${c.MCP_BEARER_TOKEN}` } } }));
  report.tools = (await client.listTools()).tools.map(t => ({ name: t.name, readOnly: t.annotations?.readOnlyHint }));
  async function call(name, args) {
    const res = await client.callTool({ name, arguments: args });
    if (res.isError) {
      const text = res.content?.find(p => p.type === 'text')?.text ?? '';
      const requestId = text.match(/request_id=([a-f0-9-]{36})/)?.[1];
      const audit = requestId ? await pool.query('SELECT error_code FROM audit_events WHERE request_id=$1 AND account_id=$2', [requestId, c.OLIST_ACCOUNT_ID]) : { rows: [] };
      report.errors.push({ tool: name, category: audit.rows[0]?.error_code ?? 'MCP_ERROR' });
      return null;
    }
    report.checks.push({ tool: name, ok: true });
    return JSON.parse(res.content.find(p => p.type === 'text').text);
  }
  const listing = await call('olist_list_products', { limit: 50, offset: 0 });
  const stocks = await call('olist_list_stock', { limit: 50, offset: 0 });
  let selected;
  let stock;
  const candidates = [...(stocks?.itens ?? []).filter(p => p.sku && p.saldo > 0).map(p => ({ id: p.idProduto, sku: p.sku })), ...(listing?.itens ?? []).filter(p => p.sku)];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    if (seen.size > 10) break;
    stock = await call('olist_get_stock', { idProduto: candidate.id });
    if (stock && typeof stock.saldo === 'number') {
      selected = await call('olist_get_product', { idProduto: candidate.id });
      if (selected?.sku && (stock.saldo > 0 || seen.size >= 10)) break;
    }
  }
  if (!selected?.sku || !stock) throw new Error('NO_CANDIDATE');
  const args = { idProduto: selected.id };
  const price = await call('olist_get_prices', args);
  const variations = await call('olist_list_variations', args);
  const sku = await call('olist_find_sku', { sku: selected.sku, limit: 50, offset: 0 });
  await call('olist_list_skus', { codigo: selected.sku, limit: 50, offset: 0 });
  report.product = { id: selected.id, sku: selected.sku, descricao: selected.descricao, tipo: selected.tipo,
    stock: { saldo: stock.saldo, reservado: stock.reservado, disponivel: stock.disponivel, depositos: stock.depositos?.length },
    price: price?.precos?.preco, promotionalPrice: price?.precos?.precoPromocional, variations: variations?.variacoes?.length ?? null };
  report.coherence = { stockId: stock.id === selected.id, stockSku: stock.codigo === selected.sku,
    priceMatchesProduct: isDeepStrictEqual(price?.precos, selected.precos),
    variationsMatchProduct: isDeepStrictEqual(variations?.variacoes, selected.variacoes ?? null),
    skuResolvesProduct: sku?.correspondenciasExatas?.some(p => p.id === selected.id),
    stockArithmetic: typeof stock.reservado === 'number' && typeof stock.disponivel === 'number' ? Math.abs(stock.saldo - stock.reservado - stock.disponivel) < 1e-6 : null };
  if (variations?.variacoes?.length) {
    const v = variations.variacoes.find(v => Number.isSafeInteger(v.id));
    if (v) {
      const detail = await call('olist_get_variation', { ...args, idVariacao: v.id });
      report.coherence.variationDetail = isDeepStrictEqual(detail, v);
    }
  }
  // Compare against independent GET responses, using the same fixed-host adapter and shared limiter.
  const rawProduct = await adapter.get(`/produtos/${selected.id}`);
  const rawStock = await adapter.get(`/estoque/${selected.id}`);
  report.coherence.directProductProjection = isDeepStrictEqual(schemas.product.parse(rawProduct), selected);
  report.coherence.directStockProjection = isDeepStrictEqual(schemas.stock.parse(rawStock), stock);
  report.productResponseFields = Object.keys(rawProduct);
  report.marketplaceFields = Object.keys(rawProduct).filter(k => /marketplace|ecommerce|anuncio|vinculo|integrac|canal/i.test(k));
  const links = await pool.query('SELECT provider,count(*)::int AS count FROM id_mappings WHERE account_id=$1 GROUP BY provider', [c.OLIST_ACCOUNT_ID]);
  report.localMappings = links.rows;
  const parent = listing?.itens?.find(p => p.tipo === 'V' || p.tipoVariacao === 'P');
  if (!variations?.variacoes?.length && parent && parent.id !== selected.id) {
    const list = await call('olist_list_variations', { idProduto: parent.id });
    report.additionalVariationSample = { id: parent.id, count: list?.variacoes?.length ?? null };
    const v = list?.variacoes?.find(v => Number.isSafeInteger(v.id));
    if (v) {
      const detail = await call('olist_get_variation', { idProduto: parent.id, idVariacao: v.id });
      report.additionalVariationSample.detailMatches = isDeepStrictEqual(detail, v);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : '';
  const safe = /^Olist HTTP \d{3}/.exec(message)?.[0] ?? (message === 'NO_CANDIDATE' ? message : 'VALIDATION_FAILED');
  report.errors.push({ category: safe }); process.exitCode = 1;
} finally {
  await client?.close(); await pool?.end();
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/read-validation.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
