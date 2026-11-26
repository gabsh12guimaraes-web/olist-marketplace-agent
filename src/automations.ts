import type { Pool } from './db.ts';
import type { ReadAdapter } from './adapters/contracts.ts';
import { recentErrors, scanCatalog, scanStock } from './diagnostics.ts';
// Every automation is a READ-ONLY report. None corrects data: corrections always go through a proposal + human approval.
export interface AutomationContext { pool: Pool; reader: ReadAdapter; account: string; tokenStatus(): Promise<{ autorizado: boolean; accessTokenExpiraEm?: string }>; marketplaces(): unknown }
export const automationDefs: Record<string, { descricao: string; run(ctx: AutomationContext): Promise<unknown> }> = {
  divergencias_estoque: { descricao: 'Estoque negativo, reservado e divergências com anúncios vinculados (2 páginas por execução)',
    run: ctx => scanStock(ctx.reader, ctx.pool, ctx.account, { offset: 0, paginas: 2, limit: 100 }) },
  produtos_sem_estoque: { descricao: 'Produtos sem disponível com anúncio vinculado ativo',
    run: async ctx => { const r = await scanStock(ctx.reader, ctx.pool, ctx.account, { offset: 0, paginas: 2, limit: 100 }); return { semEstoqueComAnuncio: r.semEstoqueComAnuncio, negativos: r.negativos.length }; } },
  skus_duplicados: { descricao: 'SKUs duplicados no catálogo observado', run: ctx => scanCatalog(ctx.reader, ctx.pool, ctx.account, { offset: 0, paginas: 2, limit: 100 }) },
  falhas_sincronizacao: { descricao: 'Erros de execução e auditoria das últimas 24 h', run: ctx => recentErrors(ctx.pool, ctx.account, 1) },
  anuncios_com_erro: { descricao: 'Anúncios rejeitados nos marketplaces (requer adaptadores autenticados)', run: async ctx => ({ marketplaces: ctx.marketplaces(), observacao: 'Nenhum adaptador de marketplace autenticado; nada a consultar.' }) },
  expiracao_tokens: { descricao: 'Estado da autorização Olist', run: ctx => ctx.tokenStatus() },
  relatorio_operacional: { descricao: 'Resumo diário de alterações e erros',
    run: async ctx => ({ alteracoes: (await ctx.pool.query(`SELECT kind,status,count(*)::int AS n FROM change_proposals WHERE account_id=$1 AND created_at>now()-interval '1 day' GROUP BY 1,2`, [ctx.account])).rows,
      erros: await recentErrors(ctx.pool, ctx.account, 1) }) },
  reprocessar_recuperaveis: { descricao: 'Lista lotes que falharam por limite/instabilidade (não reexecuta escritas)',
    run: async ctx => ({ candidatos: (await ctx.pool.query(`SELECT id,summary,blocked_reason FROM change_proposals WHERE account_id=$1 AND status='failed'
      AND blocked_reason ~ '(Rate limited|429|unavailable)' ORDER BY created_at DESC LIMIT 20`, [ctx.account])).rows,
      observacao: 'Prepare novamente o lote; escritas não são repetidas automaticamente.' }) }
};

export async function seedAutomations(pool: Pool, account: string) {
  for (const name of Object.keys(automationDefs))
    await pool.query('INSERT INTO automations(account_id,name) VALUES($1,$2) ON CONFLICT DO NOTHING', [account, name]);
}
export async function listAutomations(pool: Pool, account: string) {
  const rows = (await pool.query('SELECT name,enabled,interval_minutes,last_run_at,last_result FROM automations WHERE account_id=$1 ORDER BY name', [account])).rows;
  return rows.map(r => ({ ...r, descricao: automationDefs[r.name]?.descricao ?? 'desconhecida' }));
}
export async function setAutomation(pool: Pool, account: string, name: string, enabled: boolean, interval?: number) {
  if (!automationDefs[name]) throw new Error('Automação desconhecida');
  await pool.query('UPDATE automations SET enabled=$3,interval_minutes=coalesce($4,interval_minutes) WHERE account_id=$1 AND name=$2', [account, name, enabled, interval ?? null]);
}
// Runs due automations. Lease prevents concurrent runs across replicas.
export async function runDueAutomations(ctx: AutomationContext, only?: string) {
  const due = await ctx.pool.query(`UPDATE automations SET lease_until=now()+interval '5 minutes' WHERE account_id=$1 AND (lease_until IS NULL OR lease_until<now())
    AND ($2::text IS NOT NULL AND name=$2 OR $2::text IS NULL AND enabled AND (last_run_at IS NULL OR last_run_at < now()-(interval_minutes*interval '1 minute')))
    RETURNING name`, [ctx.account, only ?? null]);
  const results: Record<string, unknown> = {};
  for (const { name } of due.rows) {
    let result: unknown;
    try { result = { ok: true, dados: await automationDefs[name]!.run(ctx) }; }
    catch (error) { result = { ok: false, erro: error instanceof Error && /^(Olist|Rate)/.test(error.message) ? error.message : 'falha' }; }
    await ctx.pool.query('UPDATE automations SET last_run_at=now(),last_result=$3,lease_until=NULL WHERE account_id=$1 AND name=$2', [ctx.account, name, JSON.stringify(result)]);
    results[name] = result;
  }
  return results;
}
