import type { Pool } from './db.ts';
import type { ReadAdapter } from './adapters/contracts.ts';
import { OlistHttpError } from './adapters/olist.ts';
import { remember } from './db.ts';
import * as s from './schemas.ts';

export interface Explanation { causaProvavel: string; correcao: string; autoCorrigivel: boolean }
// Known failure signatures → probable cause and suggested fix. Evidence always comes from the caller.
export function explain(code: string): Explanation {
  const c = code.toUpperCase();
  if (/401|AUTHORIZE OLIST FIRST|OAUTH/.test(c)) return { causaProvavel: 'Token ausente, expirado ou revogado', correcao: 'Reautorize em /oauth/olist/connect. Se persistir, confira se o aplicativo continua ativo no ERP.', autoCorrigivel: false };
  if (/403/.test(c)) return { causaProvavel: 'Permissão negada ao módulo para o aplicativo ou para o usuário que autorizou', correcao: 'No ERP: Configurações → Aplicativos → seu aplicativo → conceder Leitura ao módulo; confira também as permissões do usuário. Depois reautorize (o escopo do token é definido na autorização).', autoCorrigivel: false };
  if (/429|RATE_LIMITED|RATE LIMITED/.test(c)) return { causaProvavel: 'Limite de requisições da API atingido (cota compartilhada com outras integrações)', correcao: 'Aguarde o cooldown; reduza OLIST_READ_RPM ou o tamanho dos lotes.', autoCorrigivel: true };
  if (/404/.test(c)) return { causaProvavel: 'Registro inexistente ou excluído', correcao: 'Confira o ID; IDs de variação e produto pai são diferentes.', autoCorrigivel: false };
  if (/5\d\d|UNAVAILABLE|TIMED OUT/.test(c)) return { causaProvavel: 'Instabilidade da API ou rede', correcao: 'Tente novamente mais tarde; escritas com resultado incerto são verificadas por leitura antes de qualquer repetição.', autoCorrigivel: true };
  if (/SCHEMA_MISMATCH/.test(c)) return { causaProvavel: 'Resposta da API fora do contrato esperado', correcao: 'Atualize docs/olist-openapi.json e os schemas; não houve gravação.', autoCorrigivel: false };
  if (/CONFLICT/.test(c)) return { causaProvavel: 'O dado mudou entre a prévia e a execução (venda, outra integração ou usuário)', correcao: 'Prepare a alteração novamente com o valor atual.', autoCorrigivel: false };
  if (/UNKNOWN/.test(c)) return { causaProvavel: 'Escrita enviada sem confirmação de resultado', correcao: 'Conferir no ERP; o sistema não reenvia automaticamente para evitar duplicidade.', autoCorrigivel: false };
  if (/WRITE_NOT_PERMITTED/.test(c)) return { causaProvavel: 'Escrita desabilitada no servidor', correcao: 'Habilite WRITE_MODE e WRITE_OPERATIONS somente após homologação.', autoCorrigivel: false };
  if (/REQUIRES_HOMOLOGATION/.test(c)) return { causaProvavel: 'Endpoint de edição completa ainda não homologado', correcao: 'Homologue PUT /produtos/{id} em produto de teste.', autoCorrigivel: false };
  return { causaProvavel: 'Não identificada', correcao: 'Consulte os logs pelo request_id.', autoCorrigivel: false };
}

const probes: { modulo: string; path: string; query?: Record<string, number> }[] = [
  { modulo: 'Produtos', path: '/produtos', query: { limit: 1, offset: 0 } },
  { modulo: 'Estoque', path: '/estoque', query: { limit: 1, offset: 0 } },
  { modulo: 'Listas de preço', path: '/listas-precos', query: { limit: 1, offset: 0 } },
  { modulo: 'Depósitos', path: '/depositos' },
  { modulo: 'Intermediadores', path: '/intermediadores', query: { limit: 1, offset: 0 } },
  { modulo: 'Marcas', path: '/marcas', query: { limit: 1, offset: 0 } },
  { modulo: 'Categorias', path: '/categorias/todas' },
  { modulo: 'Pedidos', path: '/pedidos', query: { limit: 1, offset: 0 } }
];
export async function diagnoseOlist(reader: ReadAdapter, tokenStatus: () => Promise<unknown>) {
  const results = [];
  for (const p of probes) {
    try { await reader.get(p.path, p.query); results.push({ modulo: p.modulo, endpoint: `GET ${p.path}`, status: 'ok' }); }
    catch (error) {
      const message = error instanceof Error ? error.message : '';
      const code = error instanceof OlistHttpError ? `HTTP_${error.status}` : message.startsWith('Rate limited') ? 'RATE_LIMITED'
        : /OAuth exchange failed|Authorize Olist first|Invalid encrypted token/.test(message) ? 'AUTORIZACAO_EXPIRADA' : /unavailable|timed out/.test(message) ? 'OLIST_INDISPONIVEL' : 'FALHA';
      results.push({ modulo: p.modulo, endpoint: `GET ${p.path}`, status: code, ...explain(code === 'AUTORIZACAO_EXPIRADA' ? 'OAUTH' : code) });
      if (['RATE_LIMITED', 'HTTP_401', 'AUTORIZACAO_EXPIRADA', 'OLIST_INDISPONIVEL'].includes(code)) break; // global failure: don't burn quota on every module
    }
  }
  return { token: await tokenStatus(), modulos: results };
}

// Scans /estoque pages. Distinguishes physical, reserved and available; never "fixes" anything.
export async function scanStock(reader: ReadAdapter, pool: Pool, account: string, from: { offset: number; paginas: number; limit: number }) {
  const negativos = [], reservados = [], semEstoqueComAnuncio = [], divergentes = [];
  let offset = from.offset, total = 0, lidos = 0;
  for (let page = 0; page < from.paginas; page++) {
    const data = s.stockList.parse(await reader.get('/estoque', { limit: from.limit, offset }));
    total = data.paginacao.total; lidos += data.itens.length;
    await remember(pool, account, data.itens.map(i => ({ id: i.idProduto, sku: i.sku })));
    const ids = data.itens.map(i => i.idProduto).filter((v): v is number => v !== undefined);
    const listings = ids.length ? (await pool.query(`SELECT olist_product_id,provider,listing_id,listing_status,observed_stock FROM channel_listings
      WHERE account_id=$1 AND olist_product_id = ANY($2::bigint[]) AND sync_policy='olist_master'`, [account, ids])).rows : [];
    for (const i of data.itens) {
      const info = { idProduto: i.idProduto, sku: i.sku, fisico: i.saldo, reservado: i.reservado, disponivel: i.disponivel };
      if ((i.disponivel ?? 0) < 0) negativos.push(info);
      else if ((i.reservado ?? 0) > 0) reservados.push(info);
      for (const l of listings.filter(l => Number(l.olist_product_id) === i.idProduto)) {
        if ((i.disponivel ?? 0) <= 0 && /active|ativo|normal/i.test(l.listing_status ?? '')) semEstoqueComAnuncio.push({ ...info, anuncio: `${l.provider}:${l.listing_id}` });
        if (l.observed_stock !== null && Number(l.observed_stock) !== Math.max(0, i.disponivel ?? 0)) divergentes.push({ ...info, anuncio: `${l.provider}:${l.listing_id}`, estoqueNoCanal: Number(l.observed_stock) });
      }
    }
    offset += from.limit;
    if (offset >= total) break;
  }
  return { lidos, total, proximoOffset: offset < total ? offset : null, negativos, reservados: reservados.slice(0, 200), semEstoqueComAnuncio, divergentes,
    observacao: divergentes.length || semEstoqueComAnuncio.length ? undefined : 'Divergências com canais exigem vínculos (mapping_link) e estoque observado no canal; sem adaptadores autenticados elas não podem ser detectadas.' };
}

export async function scanCatalog(reader: ReadAdapter, pool: Pool, account: string, from: { offset: number; paginas: number; limit: number }) {
  let offset = from.offset, total = 0, lidos = 0;
  const bySku = new Map<string, number[]>();
  for (let page = 0; page < from.paginas; page++) {
    const data = s.productList.parse(await reader.get('/produtos', { limit: from.limit, offset }));
    total = data.paginacao.total; lidos += data.itens.length;
    await remember(pool, account, data.itens);
    for (const p of data.itens) if (p.sku && p.id) bySku.set(p.sku, [...(bySku.get(p.sku) ?? []), p.id]);
    offset += from.limit;
    if (offset >= total) break;
  }
  // Also checks against everything observed earlier, so incremental scans still find duplicates across pages.
  const known = await pool.query(`SELECT sku, array_agg(external_id::bigint ORDER BY external_id) AS ids FROM id_mappings
    WHERE account_id=$1 AND provider='olist' AND sku IS NOT NULL GROUP BY sku HAVING count(*)>1`, [account]);
  const semVinculo = (await pool.query(`SELECT count(*)::int AS n FROM id_mappings m WHERE account_id=$1 AND provider='olist'
    AND NOT EXISTS (SELECT 1 FROM channel_listings l WHERE l.account_id=m.account_id AND (l.olist_product_id=m.external_id::bigint OR l.olist_parent_id=m.external_id::bigint))`, [account])).rows[0].n;
  const hasListings = (await pool.query('SELECT 1 FROM channel_listings WHERE account_id=$1 LIMIT 1', [account])).rowCount;
  return { lidos, total, proximoOffset: offset < total ? offset : null,
    skusDuplicados: known.rows.map(r => ({ sku: r.sku, ids: r.ids.map(Number) })),
    produtosSemVinculoLocal: hasListings ? semVinculo : null,
    observacao: hasListings ? undefined : 'Nenhum vínculo de anúncio cadastrado; "produtos sem vínculo" não pode ser avaliado.' };
}

export async function recentErrors(pool: Pool, account: string, days: number) {
  const rows = await pool.query(`SELECT tool, coalesce(error_code,'desconhecido') AS code, count(*)::int AS ocorrencias, max(created_at) AS ultima
    FROM audit_events WHERE account_id=$1 AND outcome='error' AND created_at > now()-($2*interval '1 day') GROUP BY 1,2 ORDER BY ultima DESC LIMIT 50`, [account, days]);
  const stuck = await pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE account_id=$1 AND outcome='started' AND created_at < now()-interval '10 minutes'`, [account]);
  const items = await pool.query(`SELECT i.proposal_id,i.seq,i.operation,i.status,i.message,i.target FROM change_items i JOIN change_proposals p ON p.id=i.proposal_id
    WHERE p.account_id=$1 AND i.status IN ('failed','conflict','unknown') AND p.created_at > now()-($2*interval '1 day') ORDER BY p.created_at DESC LIMIT 50`, [account, days]);
  return { erros: rows.rows.map(r => ({ ...r, ...explain(r.code) })), execucoesIncompletas: stuck.rows[0].n,
    itensComFalha: items.rows.map(i => ({ ...i, ...explain(i.status === 'failed' ? i.message ?? '' : i.status) })) };
}
