import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.ts';
import type { Pool } from './db.ts';
import { OlistHttpError } from './adapters/olist.ts';
import { marketplaceProviders } from './adapters/contracts.ts';
import * as s from './schemas.ts';
import { ChangeError, type ChangeService } from './changes.ts';
import { deleteRequest, planDelete, imagesRequest, planImagesAdd, planPriceItems, planProductCreate, planProductEdit, planSkuChange, planStockItem, planVariationCreate, priceRequest, productCreateRequest, productRequest, resolveSku, skuRequest, stockRequest, variationCreateRequest,
  type ItemPlan, type Plan, type PlanLimits, type PlanLookups } from './planners.ts';
import { readSpreadsheet } from './spreadsheet.ts';
import { diagnoseOlist, explain, recentErrors, scanCatalog, scanStock } from './diagnostics.ts';
import { linkListing, listingInput, listListings, listingsFor, reconcile } from './mapping.ts';
import { automationDefs, listAutomations, runDueAutomations } from './automations.ts';
import type { ToolContext } from './tools.ts';

export interface Operations {
  pool: Pool; config: Config; account: string; changes: ChangeService;
  lookups: PlanLookups; limits: PlanLimits & { maxItems: number };
  tokenStatus(): Promise<{ autorizado: boolean; accessTokenExpiraEm?: string }>;
  marketplaces(): unknown;
}
// Messages safe to show the agent: our own validation messages, ERP status codes and change-service codes. Never raw upstream bodies.
export class PublicError extends Error {}
function publicMessage(error: unknown): string | undefined {
  if (error instanceof ChangeError) return `${error.code}: ${error.message}`;
  if (error instanceof OlistHttpError) { const e = explain(`HTTP ${error.status}`); return `${error.message}. ${e.causaProvavel}. ${e.correcao}`; }
  if (error instanceof PublicError) return error.message;
  if (error instanceof z.ZodError) return `Entrada ou resposta fora do contrato: ${error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  if (error instanceof Error && /^(Rate limited|Olist unavailable|Authorize Olist first|Planilha|XLSX|Arquivo XLSX|Formato|Compressão)/.test(error.message)) return error.message;
  return undefined;
}
const sku = z.string().min(1).max(200);
const uuid = z.string().uuid();

export function registerOperationTools(server: McpServer, ctx: ToolContext, ops: Operations) {
  const reader = ctx.adapter;
  type Hints = { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean };
  const READ: Hints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
  const LOCAL: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
  function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, hints: Hints, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
    // ChatGPT channel: queries, plus (opt-in) preparing proposals. Never confirm/approve: execution needs the /admin panel.
    if (ctx.readOnly && !hints.readOnlyHint && !(ctx.allowPrepare && /^(change_prepare_|batch_import$|change_cancel$)/.test(name))) return;
    server.registerTool(name, { description, inputSchema: z.object(shape).strict(), annotations: { ...hints, openWorldHint: true } }, async args => {
      try {
        const data = await ctx.audit(name, () => run(args as z.infer<z.ZodObject<S>>));
        return { content: [{ type: 'text', text: JSON.stringify(data) }] };
      } catch (error) {
        const message = publicMessage(error) ?? 'Operação indisponível. Verifique autorização, limites e logs.';
        return { isError: true, content: [{ type: 'text', text: `${message} request_id=${ctx.requestId ?? 'unavailable'}` }] };
      }
    });
  }
  async function idFrom(args: { idProduto?: number; sku?: string }) {
    if (args.idProduto) return args.idProduto;
    if (!args.sku) throw new PublicError('Informe idProduto ou sku');
    const r = await resolveSku(reader, args.sku);
    if (!r.id) throw new PublicError(r.error!);
    return r.id;
  }
  // Every preview tells exactly which products and channels are affected.
  async function propose(plan: Plan) {
    const created = await ops.changes.create(plan);
    const ids = [...new Set(plan.items.map(i => i.target.idProduto).filter(Boolean))].slice(0, 50);
    const canais: Record<number, unknown> = {};
    for (const id of ids) canais[id] = await listingsFor(ops.pool, ops.account, id);
    return { ...created, canaisAfetados: canais,
      observacaoCanais: 'Alterações são feitas no ERP Olist; cada canal recebe conforme a configuração da integração Olist. Vínculos listados são os cadastrados localmente.' };
  }
  const page = s.page;

  // ---------- Consultas Olist ampliadas ----------
  tool('olist_list_deposits', 'Lista depósitos de estoque (desconsideraSaldo, padrão, reserva).', {}, READ, async () => s.deposits.parse(await reader.get('/depositos')));
  tool('olist_list_categories', 'Árvore de categorias do ERP.', {}, READ, async () => s.categories.parse(await reader.get('/categorias/todas')));
  tool('olist_list_brands', 'Lista marcas do ERP.', { ...page, descricao: z.string().min(1).max(200).optional() }, READ, async args => s.brands.parse(await reader.get('/marcas', args)));
  tool('olist_list_intermediaries', 'Lista intermediadores (canais/marketplaces cadastrados no ERP). HTTP 403 indica falta de permissão do módulo no aplicativo ou usuário.', { ...page, nome: z.string().min(1).max(200).optional() }, READ,
    async args => s.intermediaries.parse(await reader.get('/intermediadores', args)));
  tool('olist_get_stock_movements', 'Logs de movimentação de estoque de um produto (autoria e origem). Datas AAAA-MM-DD.', { idProduto: s.id, dataInicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dataFim: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), idDeposito: s.id.optional(), ...page }, READ,
    async ({ idProduto, ...q }) => reader.get(`/estoque/${idProduto}/logs-movimentacao`, q));
  tool('olist_get_product_change_log', 'Logs de alteração do cadastro de um produto.', { idProduto: s.id, ...page }, READ, async ({ idProduto, ...q }) => reader.get(`/produtos/${idProduto}/logs-alteracao`, q));
  tool('olist_list_orders', 'Lista pedidos para conciliação (sem dados pessoais do cliente). Datas AAAA-MM-DD.', { ...page, dataInicial: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), dataFinal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    situacao: z.number().int().min(0).max(10).optional(), numeroPedidoEcommerce: z.string().max(60).optional() }, READ, async args => s.orders.parse(await reader.get('/pedidos', args)));

  // ---------- Lojas, estoque e preços por canal ----------
  tool('stores_list', 'Lista Olist e marketplaces com status real (operacional só após autenticação validada), capacidades e bloqueios.', {}, READ, async () => ({ olist: await ops.tokenStatus(), marketplaces: ops.marketplaces() }));
  tool('stock_overview', 'Estoque de um produto/SKU: físico, reservado, disponível por depósito, e anúncios vinculados por canal.', { idProduto: s.id.optional(), sku: sku.optional() }, READ, async args => {
    const id = await idFrom(args); const st = s.stock.parse(await reader.get(`/estoque/${id}`));
    return { idProduto: id, sku: st.codigo, fisico: st.saldo, reservado: st.reservado, disponivel: st.disponivel, depositos: st.depositos,
      alerta: (st.disponivel ?? 0) < 0 ? 'Disponível negativo: há mais reservas que saldo físico' : undefined, canais: await listingsFor(ops.pool, ops.account, id) };
  });
  tool('price_overview', 'Preços do produto (e variações) no ERP e preços observados nos anúncios vinculados, para comparação entre canais.', { idProduto: s.id.optional(), sku: sku.optional() }, READ, async args => {
    const id = await idFrom(args); const p = s.product.parse(await reader.get(`/produtos/${id}`));
    const listings = await listingsFor(ops.pool, ops.account, id);
    return { idProduto: id, sku: p.sku, erp: p.precos, variacoes: p.variacoes?.map(v => ({ id: v.id, sku: v.sku, precos: v.precos })),
      canais: listings.map(l => ({ canal: l.provider, anuncio: l.listing_id, precoObservado: l.observed_price, observadoEm: l.observed_at })),
      observacao: 'Preço final do canal (comissões, frete, listas de preço da integração) não é calculado.' };
  });

  // ---------- Vínculos ----------
  tool('mapping_list', 'Lista vínculos produto/variação Olist ↔ anúncio de marketplace.', { olistProductId: s.id.optional(), sku: sku.optional(), provider: z.enum(marketplaceProviders).optional(), ...page }, READ,
    async args => listListings(ops.pool, ops.account, args));
  tool('mapping_link', 'Cadastra/atualiza localmente um vínculo produto Olist ↔ anúncio. Não altera ERP nem marketplace.', listingInput.shape, LOCAL, async args => linkListing(ops.pool, reader, ops.account, args));
  tool('mapping_reconcile', 'Verifica vínculos contra o ERP (SKU alterado, variação inexistente, anúncio duplicado). Somente relatório.', { limite: z.number().int().min(1).max(100).default(20) }, READ,
    async ({ limite }) => reconcile(ops.pool, reader, ops.account, limite));

  // ---------- Diagnóstico ----------
  tool('diagnose_connections', 'Testa autorização e permissões por módulo da Olist (inclui o 403 de Intermediadores) e o estado dos marketplaces.', {}, READ,
    async () => ({ olist: await diagnoseOlist(reader, ops.tokenStatus), marketplaces: ops.marketplaces(), escrita: { modo: ops.config.WRITE_MODE, operacoes: ops.config.WRITE_OPERATIONS, aprovacao: ops.config.APPROVAL_MODE } }));
  tool('diagnose_stock', 'Varre páginas de /estoque: negativos, reservados, sem estoque com anúncio ativo e divergências com canais. Use proximoOffset para continuar.', { offset: z.number().int().min(0).default(0), paginas: z.number().int().min(1).max(10).default(2), limit: z.number().int().min(1).max(100).default(100) }, READ,
    async args => scanStock(reader, ops.pool, ops.account, args));
  tool('diagnose_catalog', 'Varre páginas do catálogo: SKUs duplicados (inclusive entre varreduras) e produtos sem vínculo.', { offset: z.number().int().min(0).default(0), paginas: z.number().int().min(1).max(10).default(2), limit: z.number().int().min(1).max(100).default(100) }, READ,
    async args => scanCatalog(reader, ops.pool, ops.account, args));
  tool('errors_recent', 'Erros recentes de consultas e execuções, com causa provável e correção sugerida.', { dias: z.number().int().min(1).max(90).default(7) }, READ, async ({ dias }) => recentErrors(ops.pool, ops.account, dias));
  tool('error_explain', 'Explica um código/mensagem de erro (HTTP 403, 429, CONFLICT…).', { codigo: z.string().min(1).max(200) }, READ, async ({ codigo }) => explain(codigo));

  // ---------- Preparar alterações (nada é enviado ao ERP) ----------
  tool('change_prepare_stock', 'Prepara ajuste de estoque para um valor FINAL (balanço) em um depósito. alvo=fisico define o saldo; alvo=disponivel define saldo−reservado. Retorna prévia com antes/depois.',
    { ...stockRequest.shape, sku: sku.optional(), idProduto: s.id.optional() }, LOCAL, async ({ sku: skuArg, ...args }) => {
      const id = await idFrom({ idProduto: args.idProduto, sku: skuArg });
      const { item, risks } = await planStockItem(reader, { ...stockRequest.parse({ ...args, idProduto: id }) });
      return propose({ kind: 'stock', summary: `Estoque ${item.target.sku ?? id}: ${args.alvo} → ${args.quantidade}`, risks, items: [item], request: { ...args, idProduto: id } });
    });
  tool('change_prepare_price', 'Prepara alteração de preço: itens com preço final, ou idsProdutos + percentual (ex.: 5 = +5%). Valida limite de variação, preço/margem mínimos configurados.',
    { itens: z.array(z.object({ idProduto: s.id, idVariacao: s.id.optional(), preco: z.number().positive(), precoPromocional: z.number().min(0).nullable().optional() }).strict()).optional(),
      idsProdutos: z.array(s.id).optional(), percentual: z.number().optional(), aceitarVariacaoAlta: z.boolean().optional() }, LOCAL, async args => {
      const req = priceRequest.parse(Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)));
      const count = 'itens' in req ? req.itens.length : req.idsProdutos.length;
      if (count > ops.limits.maxItems) throw new PublicError(`Máximo de ${ops.limits.maxItems} itens por proposta`);
      const { items, risks } = await planPriceItems(reader, ops.lookups, ops.limits, req);
      return propose({ kind: 'price', summary: 'percentual' in req ? `Reajuste de ${req.percentual}% em ${count} produto(s)` : `Preço de ${count} item(ns)`, risks, items, request: req });
    });
  tool('change_prepare_product', 'Prepara edição de título (descricao), descrição longa, GTIN, marca, categoria ou observações.', productRequest.shape, LOCAL,
    async args => propose(await planProductEdit(reader, ops.lookups, ops.limits, args)));
  tool('change_prepare_create_product', 'Prepara o CADASTRO de um produto novo no ERP (simples ou com variações). Valida SKUs inexistentes, grade e dados exigidos por marketplaces. Não publica anúncios.',
    productCreateRequest.shape, LOCAL, async args => propose(await planProductCreate(reader, productCreateRequest.parse(args))));
  tool('change_prepare_create_variation', 'Prepara o cadastro de uma nova variação (ex.: novo tamanho/cor) em um produto pai existente.',
    variationCreateRequest.shape, LOCAL, async args => propose(await planVariationCreate(reader, variationCreateRequest.parse(args))));  tool('change_prepare_add_images', 'Prepara a inclusão de imagens (URLs HTTPS) em produtos ou VARIAÇÕES (use o ID da variação). Só acrescenta; nunca remove imagens existentes.',
    imagesRequest.shape, LOCAL, async args => propose(await planImagesAdd(reader, imagesRequest.parse(args))));
  tool('change_prepare_delete', 'Prepara a EXCLUSÃO IRREVERSÍVEL de até 5 produtos ou variações. Bloqueia se houver estoque reservado (pedidos em aberto), anúncios vinculados, produto pai sem incluirVariacoes=true ou mais de 10 variações. Guarda um retrato do cadastro na auditoria. Execução só após aprovação humana no /admin.',
    deleteRequest.shape, LOCAL, async args => propose(await planDelete(reader, ops.lookups, deleteRequest.parse(args))));
  tool('change_prepare_sku', 'Analisa alteração de SKU: variações, vínculos, duplicidade, limitações da API. Bloqueia quando inseguro e apresenta o procedimento recomendado.', skuRequest.shape, LOCAL,
    async args => propose(await planSkuChange(reader, ops.lookups, ops.limits, args)));
  tool('change_prepare_revert', 'Prepara a reversão (compensação) dos itens de preço/estoque bem-sucedidos de uma proposta, voltando aos valores anteriores.', { proposalId: uuid }, LOCAL, async ({ proposalId }) => {
    const original = await ops.changes.view(proposalId);
    const items: ItemPlan[] = [], risks: string[] = [];
    for (const i of original.itens.filter(i => i.status === 'succeeded')) {
      if (i.operation === 'price' && i.before) {
        const r = await planPriceItems(reader, ops.lookups, { ...ops.limits, maxPriceChangePct: 500 }, { itens: [{ idProduto: i.target.idProduto, idVariacao: i.target.idVariacao, preco: Number(i.before.preco), precoPromocional: (i.before.precoPromocional as number | null) ?? null }], aceitarVariacaoAlta: true });
        items.push(...r.items); risks.push(...r.risks);
      } else if (i.operation === 'stock_balance' && i.before) {
        const r = await planStockItem(reader, { idProduto: i.target.idProduto, idDeposito: i.target.idDeposito, quantidade: Number(i.before.saldoDeposito), alvo: 'fisico', permitirDisponivelNegativo: true, observacao: `Reversão ${proposalId}`.slice(0, 200) });
        if (r.item.before && r.item.before.saldoDeposito !== i.after.quantidade) risks.push(`Produto ${i.target.idProduto}: estoque mudou depois da execução original (vendas/entradas); a reversão sobrescreve com ${i.before.saldoDeposito}.`);
        items.push(r.item); risks.push(...r.risks);
      } else risks.push(`Item ${i.seq} (${i.operation}) não suporta reversão automática.`);
    }
    if (!items.length) throw new PublicError('Nenhum item revertível (somente preço e estoque executados com sucesso)');
    return propose({ kind: 'batch', summary: `Reversão da proposta ${proposalId}`, risks, items, request: { reverter: proposalId } });
  });

  // ---------- Lote ----------
  tool('batch_import', 'Importa CSV (conteudoTexto ou base64) ou XLSX (base64) e cria proposta em lote; a validação por linha roda em segundo plano. Colunas: sku|idProduto, idVariacao, estoque, alvo (fisico|disponivel), deposito, preco, precoPromocional, novoSku (troca de SKU; pula itens com pedido em aberto), marketplace, loja, alteracao.',
    { nomeArquivo: z.string().min(1).max(200), conteudoTexto: z.string().max(2_000_000).optional(), conteudoBase64: z.string().max(4_000_000).optional(),
      alvoEstoquePadrao: z.enum(['fisico', 'disponivel']).optional(), aceitarVariacaoAlta: z.boolean().default(false) }, LOCAL, async args => {
      const { rows, ignoredColumns } = readSpreadsheet(args);
      if (!rows.length) throw new PublicError('Planilha sem linhas de dados');
      const request = { arquivo: args.nomeArquivo, linhas: rows, alvoEstoquePadrao: args.alvoEstoquePadrao, aceitarVariacaoAlta: args.aceitarVariacaoAlta };
      const created = await ops.changes.create({ kind: 'batch', summary: `Lote ${args.nomeArquivo}: ${rows.length} linha(s) em validação`, risks: [], items: [], request }, { batch: rows, alvo: args.alvoEstoquePadrao });
      return { ...created, linhas: rows.length, colunasIgnoradas: ignoredColumns };
    });

  // ---------- Confirmação, status e histórico ----------
  tool('change_confirm', 'Confirma uma proposta. Modo admin: só executa após aprovação humana no painel /admin (o agente não aprova). Modo client: exige o codigoConfirmacao devolvido na prévia e confirmação explícita do usuário.',
    { proposalId: uuid, codigoConfirmacao: z.string().max(100).optional() }, { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, async ({ proposalId, codigoConfirmacao }) => {
      const current = await ops.changes.view(proposalId);
      if (current.status === 'pending') {
        if (ops.config.APPROVAL_MODE === 'admin') return current;
        await ops.changes.approve(proposalId, 'client', codigoConfirmacao);
      }
      return ops.changes.runById(proposalId, 40_000);
    });
  tool('change_get', 'Status e resultado por item (antes, depois, sucesso, erro, omissão e motivo) de uma proposta/tarefa.', { proposalId: uuid }, READ, async ({ proposalId }) => ops.changes.view(proposalId));
  tool('change_cancel', 'Cancela uma proposta ainda não executada.', { proposalId: uuid }, LOCAL, async ({ proposalId }) => ops.changes.reject(proposalId, 'client'));
  tool('change_history', 'Histórico de propostas/alterações (ex.: desde=hoje 00:00).', { status: z.enum(['preparing', 'pending', 'executing', 'succeeded', 'partial', 'failed', 'expired', 'cancelled', 'rejected', 'blocked']).optional(),
    desde: z.string().datetime({ offset: true }).optional(), limit: z.number().int().min(1).max(100).default(20) }, READ, async ({ status, desde, limit }) => ops.changes.list({ status, since: desde, limit }));
  tool('verify_sync', 'Relê no ERP os itens executados de uma proposta e compara com o valor desejado; mostra o observado nos canais vinculados.', { proposalId: uuid }, READ, async ({ proposalId }) => {
    const p = await ops.changes.view(proposalId); const result = [];
    for (const i of p.itens.filter(i => i.status === 'succeeded').slice(0, 50)) {
      let atual: unknown, confere = false;
      if (i.operation === 'stock_balance') { const st = s.stock.parse(await reader.get(`/estoque/${i.target.idProduto}`)); const d = st.depositos?.find(d => d.id === i.target.idDeposito); atual = { saldo: d?.saldo, reservado: d?.reservado, disponivel: d?.disponivel }; confere = d?.saldo === i.after.quantidade; }
      else if (i.operation === 'price') { const pr = s.product.parse(await reader.get(`/produtos/${i.target.idProduto}`)); const n = i.target.idVariacao ? pr.variacoes?.find(v => v.id === i.target.idVariacao) : pr; atual = n?.precos; confere = n?.precos?.preco === i.after.preco; }
      else { atual = 'verificação manual'; }
      result.push({ seq: i.seq, idProduto: i.target.idProduto, esperado: i.after, atual, confereNoErp: confere, canais: await listingsFor(ops.pool, ops.account, i.target.idProduto) });
    }
    return { proposalId, itens: result, observacao: 'Propagação para os canais depende da integração Olist; leitura direta dos canais requer adaptadores autenticados.' };
  });

  // ---------- Automações (somente relatórios) ----------
  tool('automation_list', 'Lista automações (todas começam desativadas; habilitação somente no painel /admin) e o último resultado.', {}, READ, async () => listAutomations(ops.pool, ops.account));
  tool('automation_run', 'Executa sob demanda uma automação de relatório (não altera dados).', { nome: z.enum(Object.keys(automationDefs) as [string, ...string[]]) }, READ,
    async ({ nome }) => runDueAutomations({ pool: ops.pool, reader, account: ops.account, tokenStatus: ops.tokenStatus, marketplaces: ops.marketplaces }, nome));
}
