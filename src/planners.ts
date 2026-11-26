import { z } from 'zod';
import type { ReadAdapter } from './adapters/contracts.ts';
import * as s from './schemas.ts';
// Planners only READ. They turn a request into item plans with exact before/after values and risks.
export type Operation = 'stock_balance' | 'price' | 'product_update' | 'sku_update' | 'product_create' | 'variation_create' | 'images_add' | 'product_delete' | 'variation_delete';
export type Kind = 'stock' | 'price' | 'product' | 'sku' | 'batch';
export interface ItemPlan {
  operation: Operation;
  target: { idProduto: number; idVariacao?: number; idDeposito?: number; sku?: string | null; linha?: number };
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
  status: 'pending' | 'skipped' | 'invalid';
  message?: string;
}
export interface Plan { kind: Kind; summary: string; risks: string[]; blocked?: string; items: ItemPlan[]; request: unknown }
export interface PlanLimits { maxPriceChangePct: number; productPutVerified: boolean; homologationProductIds?: readonly number[] }
// Full-replacement PUT is allowed on designated test products before global homologation.
const putAllowed = (limits: PlanLimits, id: number) => limits.productPutVerified || (limits.homologationProductIds ?? []).includes(id);
export interface PlanLookups {
  priceGuard(idProduto: number): Promise<{ min_price: number | null; min_margin_pct: number | null } | null>;
  listings(idProduto: number): Promise<{ provider: string; listing_id: string; store_id: string }[]>;
}
export const round2 = (v: number) => Math.round(v * 100) / 100;
const stockTarget = z.enum(['fisico', 'disponivel']);
export const stockRequest = z.object({
  idProduto: s.id.describe('ID Olist do produto simples ou da variação (o estoque é por ID, não por SKU)'),
  quantidade: z.number().finite().min(0).max(1_000_000),
  alvo: stockTarget.describe('fisico: saldo final registrado no depósito; disponivel: saldo final menos reservado'),
  idDeposito: s.id.optional(),
  permitirDisponivelNegativo: z.boolean().default(false),
  observacao: z.string().max(200).optional()
}).strict();
export const priceItem = z.object({ idProduto: s.id, idVariacao: s.id.optional(), preco: z.number().positive().max(10_000_000), precoPromocional: z.number().min(0).max(10_000_000).nullable().optional() }).strict();
export const priceRequest = z.union([
  z.object({ itens: z.array(priceItem).min(1).max(1000), aceitarVariacaoAlta: z.boolean().default(false) }).strict(),
  z.object({ idsProdutos: z.array(s.id).min(1).max(1000), percentual: z.number().min(-90).max(500).refine(v => v !== 0), aceitarVariacaoAlta: z.boolean().default(false) }).strict()
]);
export const productEditable = z.object({
  descricao: z.string().min(1).max(120).optional().describe('Título/nome do produto no ERP'),
  descricaoComplementar: z.string().max(20000).optional().describe('Descrição longa'),
  gtin: z.string().regex(/^\d{8,14}$/).optional(),
  marca: z.object({ id: s.id }).strict().optional(),
  categoria: z.object({ id: s.id }).strict().optional(),
  observacoes: z.string().max(2000).optional(),
  ncm: z.string().regex(/^\d{4}\.?\d{2}\.?\d{2}$/).optional(), origem: z.number().int().min(0).max(8).optional(),
  unidade: z.string().min(1).max(6).optional(), garantia: z.string().max(200).optional(),
  dimensoes: z.object({ largura: z.number().min(0).optional(), altura: z.number().min(0).optional(), comprimento: z.number().min(0).optional(),
    pesoLiquido: z.number().min(0).optional(), pesoBruto: z.number().min(0).optional() }).strict().refine(v => Object.keys(v).length > 0).optional()
}).strict().refine(v => Object.keys(v).length > 0, 'Informe ao menos uma alteração');
export const productRequest = z.object({ idProduto: s.id, alteracoes: productEditable }).strict();
export const skuRequest = z.object({ idProduto: s.id, novoSku: z.string().trim().min(1).max(60).regex(/^[\w.\-/]+$/) }).strict();

async function readStock(reader: ReadAdapter, id: number) { return s.stock.parse(await reader.get(`/estoque/${id}`)); }
async function readProduct(reader: ReadAdapter, id: number) { return s.product.parse(await reader.get(`/produtos/${id}`)); }

export async function planStockItem(reader: ReadAdapter, req: z.infer<typeof stockRequest>, linha?: number): Promise<{ item: ItemPlan; risks: string[] }> {
  const risks: string[] = [];
  const stock = await readStock(reader, req.idProduto);
  const target = { idProduto: req.idProduto, sku: stock.codigo ?? null, linha };
  const deposits = (stock.depositos ?? []).filter(d => d.id !== undefined);
  const usable = deposits.filter(d => !d.desconsiderar);
  const deposit = req.idDeposito !== undefined ? deposits.find(d => d.id === req.idDeposito) : usable.length === 1 ? usable[0] : undefined;
  const invalid = (message: string): { item: ItemPlan; risks: string[] } => ({ item: { operation: 'stock_balance', target, before: null, after: {}, status: 'invalid', message }, risks });
  if (!deposit) return invalid(req.idDeposito !== undefined ? 'Depósito informado não retornado para este produto' : `Informe idDeposito: ${usable.length} depósitos considerados`);
  if (deposit.desconsiderar) risks.push(`Depósito ${deposit.id} está marcado para desconsiderar saldo; a alteração pode não refletir nos canais`);
  const saldo = deposit.saldo ?? 0, reservado = deposit.reservado ?? stock.reservado ?? 0;
  const before = { saldoTotal: stock.saldo ?? null, reservadoTotal: stock.reservado ?? null, disponivelTotal: stock.disponivel ?? null,
    idDeposito: deposit.id, saldoDeposito: saldo, reservadoDeposito: reservado, disponivelDeposito: deposit.disponivel ?? saldo - reservado };
  if ((stock.disponivel ?? 0) < 0) risks.push(`SKU ${stock.codigo ?? req.idProduto}: disponível atual negativo (${stock.disponivel}) — saldo ${stock.saldo}, reservado ${stock.reservado}. Verifique pedidos/reservas antes de ajustar.`);
  const finalPhysical = req.alvo === 'fisico' ? req.quantidade : req.quantidade + reservado;
  const finalAvailable = finalPhysical - reservado;
  const movement = round2(finalPhysical - saldo);
  let precoUnitario: number | null = null;
  try {
    const product = await readProduct(reader, req.idProduto);
    if (product.tipoVariacao === 'P') return invalid(`Produto pai com variações: ajuste o estoque de cada variação (${(product.variacoes ?? []).map(v => v.id).join(', ')})`);
    precoUnitario = product.precos?.precoCusto ?? null;
  } catch { /* cost is optional; never presumed */ }
  const after = { tipo: 'B', deposito: { id: deposit.id }, quantidade: finalPhysical, precoUnitario,
    observacoes: (req.observacao ?? 'Ajuste via agente MCP').slice(0, 200), movimentacaoCalculada: movement, disponivelResultante: finalAvailable, alvo: req.alvo };
  const item: ItemPlan = { operation: 'stock_balance', target: { ...target, idDeposito: deposit.id }, before, after, status: 'pending' };
  if (!Number.isInteger(finalPhysical)) risks.push('Quantidade fracionária: confirme se a unidade do produto aceita frações');
  if (movement === 0) { item.status = 'skipped'; item.message = 'Saldo do depósito já está no valor desejado'; }
  else if (finalAvailable < 0 && !req.permitirDisponivelNegativo) { item.status = 'invalid'; item.message = `Resultado deixaria disponível negativo (${finalAvailable}) porque há ${reservado} reservado(s). Use alvo=disponivel ou permitirDisponivelNegativo=true.`; }
  return { item, risks };
}

export async function planPriceItems(reader: ReadAdapter, lookups: PlanLookups, limits: PlanLimits, req: z.infer<typeof priceRequest>): Promise<{ items: ItemPlan[]; risks: string[] }> {
  const risks: string[] = [], items: ItemPlan[] = [];
  const wanted = 'itens' in req ? req.itens.map(i => ({ ...i, percentual: undefined as number | undefined }))
    : req.idsProdutos.map(idProduto => ({ idProduto, idVariacao: undefined, preco: undefined, precoPromocional: undefined, percentual: req.percentual }));
  for (const w of wanted) {
    const target = { idProduto: w.idProduto, idVariacao: w.idVariacao, sku: null as string | null };
    try {
      const product = await readProduct(reader, w.idProduto);
      const node = w.idVariacao === undefined ? product : product.variacoes?.find(v => v.id === w.idVariacao);
      if (!node) { items.push({ operation: 'price', target, before: null, after: {}, status: 'invalid', message: 'Variação não retornada pelo produto pai' }); continue; }
      target.sku = node.sku ?? null;
      if (w.idVariacao === undefined && (product.variacoes?.length ?? 0) > 0 && w.percentual !== undefined)
        risks.push(`Produto ${w.idProduto} tem variações; o reajuste altera apenas o preço do pai. Inclua as variações explicitamente se necessário.`);
      const current = { preco: node.precos?.preco ?? null, precoPromocional: node.precos?.precoPromocional ?? null, precoCusto: node.precos?.precoCusto ?? null };
      const preco = w.preco ?? (current.preco === null ? null : round2(current.preco * (1 + w.percentual! / 100)));
      if (preco === null || preco <= 0) { items.push({ operation: 'price', target, before: current, after: {}, status: 'invalid', message: 'Preço atual ausente; reajuste percentual impossível' }); continue; }
      const precoPromocional = w.precoPromocional !== undefined ? w.precoPromocional : current.precoPromocional;
      const item: ItemPlan = { operation: 'price', target, before: current, after: { preco, precoPromocional }, status: 'pending' };
      const changePct = current.preco ? round2((preco / current.preco - 1) * 100) : null;
      item.after.variacaoPercentual = changePct;
      const guard = await lookups.priceGuard(w.idProduto);
      if (preco === current.preco && precoPromocional === current.precoPromocional) { item.status = 'skipped'; item.message = 'Preço já está no valor desejado'; }
      else if (changePct !== null && Math.abs(changePct) > limits.maxPriceChangePct && !req.aceitarVariacaoAlta) { item.status = 'invalid'; item.message = `Variação de ${changePct}% excede o limite de ${limits.maxPriceChangePct}%; revise ou use aceitarVariacaoAlta=true`; }
      else if (guard?.min_price != null && preco < Number(guard.min_price)) { item.status = 'invalid'; item.message = `Abaixo do preço mínimo configurado (${guard.min_price})`; }
      else if (guard?.min_margin_pct != null) {
        if (!current.precoCusto) { item.status = 'invalid'; item.message = 'Margem mínima configurada, mas o produto não tem custo cadastrado'; }
        else if ((preco - current.precoCusto) / preco * 100 < Number(guard.min_margin_pct)) { item.status = 'invalid'; item.message = `Margem abaixo do mínimo configurado (${guard.min_margin_pct}%)`; }
      }
      if (precoPromocional && precoPromocional >= preco) risks.push(`SKU ${target.sku ?? w.idProduto}: preço promocional (${precoPromocional}) ≥ preço (${preco})`);
      items.push(item);
    } catch (error) {
      items.push({ operation: 'price', target, before: null, after: {}, status: 'invalid', message: error instanceof Error && /^Olist HTTP/.test(error.message) ? error.message : 'Falha ao consultar o produto' });
    }
  }
  return { items, risks };
}

export async function planProductEdit(reader: ReadAdapter, lookups: PlanLookups, limits: PlanLimits, req: z.infer<typeof productRequest>): Promise<Plan> {
  const raw = await reader.get(`/produtos/${req.idProduto}`) as Record<string, unknown>;
  const product = s.product.parse(raw);
  const before: Record<string, unknown> = { sku: product.sku, descricao: product.descricao };
  for (const key of Object.keys(req.alteracoes)) before[key] = raw[key] ?? null;
  const risks = ['Textos de marketplaces podem ter limites próprios de tamanho e termos proibidos; o ERP propaga conforme a configuração de cada integração.'];
  const listings = await lookups.listings(req.idProduto);
  if (listings.length) risks.push(`${listings.length} anúncio(s) vinculado(s) localmente podem receber a alteração pela integração Olist.`);
  const blocked = putAllowed(limits, req.idProduto) ? undefined
    : 'PUT /produtos/{id} exige o cadastro completo (sku e descricao obrigatórios) e não foi homologado: campos omitidos podem ser apagados. Homologue em um produto de teste (HOMOLOGATION_PRODUCT_IDS) e depois defina OLIST_PRODUCT_PUT_VERIFIED=true.';
  if (!limits.productPutVerified && putAllowed(limits, req.idProduto)) risks.push('HOMOLOGAÇÃO: produto de teste. Depois de executar, confira no ERP campo a campo se nada além do pedido mudou.');
  return { kind: 'product', summary: `Editar produto ${product.sku ?? req.idProduto}: ${Object.keys(req.alteracoes).join(', ')}`, risks, blocked, request: req,
    items: [{ operation: 'product_update', target: { idProduto: req.idProduto, sku: product.sku }, before, after: { ...req.alteracoes }, status: 'pending' }] };
}

export async function planSkuChange(reader: ReadAdapter, lookups: PlanLookups, limits: PlanLimits, req: z.infer<typeof skuRequest>): Promise<Plan> {
  const product = await readProduct(reader, req.idProduto);
  const risks: string[] = [], reasons: string[] = [];
  const same = s.productList.parse(await reader.get('/produtos', { codigo: req.novoSku, limit: 100, offset: 0 })).itens.filter(p => p.sku === req.novoSku);
  if (same.length) reasons.push(`O SKU ${req.novoSku} já existe nos IDs ${same.map(p => p.id).join(', ')}`);
  const listings = await lookups.listings(req.idProduto);
  if (listings.length) reasons.push(`${listings.length} anúncio(s) vinculado(s): ${listings.slice(0, 10).map(l => `${l.provider}:${l.listing_id}`).join(', ')}. Integrações costumam vincular por SKU; a troca pode desvincular ou duplicar anúncios.`);
  if ((product.variacoes?.length ?? 0) > 0) risks.push(`Produto pai com ${product.variacoes!.length} variações; os SKUs das variações não são alterados por esta operação.`);
  risks.push('A API Olist não permite filtrar pedidos por produto; pedidos em aberto com o SKU antigo devem ser conferidos no ERP antes da troca.');
  if (!putAllowed(limits, req.idProduto)) reasons.push('PUT /produtos/{id} não homologado (OLIST_PRODUCT_PUT_VERIFIED=false).');
  const procedure = 'Procedimento recomendado: 1) pausar a sincronização do anúncio no canal; 2) conferir pedidos em aberto; 3) alterar o SKU no ERP; 4) revincular o anúncio no hub da Olist; 5) verificar estoque e preço no canal.';
  return { kind: 'sku', summary: `Alterar SKU ${product.sku ?? '?'} → ${req.novoSku} (ID ${req.idProduto})`, risks: [...risks, procedure], request: req,
    blocked: reasons.length ? reasons.join(' ') : undefined,
    items: [{ operation: 'sku_update', target: { idProduto: req.idProduto, sku: product.sku }, before: { sku: product.sku, descricao: product.descricao }, after: { sku: req.novoSku }, status: 'pending' }] };
}

// Batch variant of planSkuChange: same checks per row, plus rows with reserved stock (open orders) are skipped.
export async function planSkuItem(reader: ReadAdapter, lookups: PlanLookups, limits: PlanLimits, req: z.infer<typeof skuRequest>, linha?: number): Promise<ItemPlan> {
  const product = await readProduct(reader, req.idProduto);
  const target = { idProduto: req.idProduto, sku: product.sku, linha };
  const before = { sku: product.sku, descricao: product.descricao };
  const reject = (message: string, status: ItemPlan['status'] = 'invalid'): ItemPlan => ({ operation: 'sku_update', target, before, after: { sku: req.novoSku }, status, message });
  if (product.sku === req.novoSku) return reject('SKU já está no valor pedido', 'skipped');
  if (!putAllowed(limits, req.idProduto)) return reject('PUT /produtos/{id} não homologado (OLIST_PRODUCT_PUT_VERIFIED=false).');
  const same = s.productList.parse(await reader.get('/produtos', { codigo: req.novoSku, limit: 100, offset: 0 })).itens.filter(p => p.sku === req.novoSku && p.id !== req.idProduto);
  if (same.length) return reject(`O SKU ${req.novoSku} já existe nos IDs ${same.map(p => p.id).join(', ')}`);
  const listings = await lookups.listings(req.idProduto);
  if (listings.length) return reject(`${listings.length} anúncio(s) vinculado(s) localmente; troque individualmente com change_prepare_sku.`);
  const stock = await readStock(reader, req.idProduto);
  if ((stock.reservado ?? 0) > 0) return reject(`${stock.reservado} unidade(s) reservada(s) por pedido em aberto; troque depois que o pedido for faturado.`, 'skipped');
  return { operation: 'sku_update', target, before, after: { sku: req.novoSku }, status: 'pending' };
}

// ---------- Cadastro (POST /produtos, POST /produtos/{id}/variacoes) ----------
const skuText = z.string().trim().min(1).max(60).regex(/^[\w.\-/]+$/);
const money = z.number().min(0).max(10_000_000);
const gradeItem = z.object({ chave: z.string().trim().min(1).max(60), valor: z.string().trim().min(1).max(120) }).strict();
const newVariation = z.object({
  sku: skuText, gtin: z.string().regex(/^\d{8,14}$/).optional(),
  precos: z.object({ preco: money.optional(), precoPromocional: money.nullable().optional() }).strict().optional(),
  estoqueInicial: z.number().min(0).max(1_000_000).optional(),
  grade: z.array(gradeItem).min(1).max(5)
}).strict();
export const productCreateRequest = z.object({
  sku: skuText, descricao: z.string().trim().min(1).max(120).describe('Título/nome do produto'),
  tipo: z.enum(['S', 'V']).describe('S = simples; V = com variações'),
  descricaoComplementar: z.string().max(20000).optional(), unidade: z.string().max(6).optional(),
  gtin: z.string().regex(/^\d{8,14}$/).optional(), ncm: z.string().regex(/^\d{4}\.?\d{2}\.?\d{2}$/).optional(), origem: z.number().int().min(0).max(8).optional(),
  marca: z.object({ id: s.id }).strict().optional(), categoria: z.object({ id: s.id }).strict().optional(),
  precos: z.object({ preco: money.optional(), precoPromocional: money.nullable().optional(), precoCusto: money.optional() }).strict().optional(),
  dimensoes: z.object({ largura: z.number().min(0).optional(), altura: z.number().min(0).optional(), comprimento: z.number().min(0).optional(),
    pesoLiquido: z.number().min(0).optional(), pesoBruto: z.number().min(0).optional() }).strict().optional(),
  estoqueInicial: z.number().min(0).max(1_000_000).optional().describe('Somente produto simples'),
  imagens: z.array(z.string().url().startsWith('https://').max(2000)).max(20).optional().describe('URLs HTTPS públicas das imagens'),
  grade: z.array(z.string().trim().min(1).max(60)).min(1).max(5).optional().describe("Chaves da grade, ex.: ['Tamanho','Cor'] (obrigatório se tipo=V)"),
  variacoes: z.array(newVariation).max(200).optional()
}).strict();
export const variationCreateRequest = z.object({ idProduto: s.id.describe('ID do produto pai (tipo com variações)') }).merge(newVariation).strict();

const sameKeys = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
async function skusInUse(reader: ReadAdapter, skus: string[]) {
  const used: string[] = [];
  for (const sku of skus) { const r = await resolveSku(reader, sku); if (r.id || r.error?.startsWith('SKU duplicado')) used.push(sku); }
  return used;
}

export async function planProductCreate(reader: ReadAdapter, req: z.infer<typeof productCreateRequest>): Promise<Plan> {
  const risks: string[] = [], problems: string[] = [];
  const variations = req.variacoes ?? [];
  if (req.tipo === 'V') {
    if (!req.grade?.length || !variations.length) problems.push('Produto com variações exige grade e ao menos uma variação');
    for (const v of variations) if (req.grade && !sameKeys(v.grade.map(g => g.chave), req.grade)) problems.push(`Variação ${v.sku}: chaves da grade devem ser exatamente ${req.grade.join(', ')}`);
    const combos = variations.map(v => [...v.grade].sort((a, b) => a.chave.localeCompare(b.chave)).map(g => `${g.chave}=${g.valor}`).join('|'));
    if (new Set(combos).size !== combos.length) problems.push('Há variações com a mesma combinação de grade');
    if (req.estoqueInicial !== undefined) problems.push('Em produto com variações informe estoqueInicial em cada variação');
  } else if (variations.length || req.grade) problems.push('Produto simples (tipo S) não aceita grade/variações');
  const allSkus = [req.sku, ...variations.map(v => v.sku)];
  if (new Set(allSkus).size !== allSkus.length) problems.push('SKUs repetidos na solicitação');
  const used = await skusInUse(reader, [...new Set(allSkus)]);
  if (used.length) problems.push(`SKU(s) já cadastrado(s) no ERP: ${used.join(', ')}`);
  if (!req.precos?.preco && !variations.some(v => v.precos?.preco)) risks.push('Sem preço de venda informado: o produto será criado com preço vazio/zero.');
  if (!req.ncm) risks.push('Sem NCM: a emissão de nota fiscal e alguns marketplaces exigem NCM.');
  if (!req.gtin && req.tipo === 'S') risks.push('Sem GTIN/EAN: vários marketplaces exigem código de barras ou isenção.');
  if (!req.dimensoes?.pesoBruto) risks.push('Sem peso/dimensões: o cálculo de frete nos canais pode falhar.');
  if (req.imagens?.length) risks.push('Imagens são enviadas como URLs externas; o ERP/canais precisam conseguir baixá-las.');
  risks.push('O cadastro NÃO publica anúncios: a publicação nos marketplaces é feita no painel da Olist (integrações).');
  // Olist ignores estoque.inicial (and later balances) unless stock control is on; for variations it is read from the parent.
  const tracked = req.estoqueInicial !== undefined || variations.some(v => v.estoqueInicial !== undefined);
  const payload = { sku: req.sku, descricao: req.descricao, tipo: req.tipo, descricaoComplementar: req.descricaoComplementar, unidade: req.unidade ?? 'UN',
    gtin: req.gtin, ncm: req.ncm, origem: req.origem, marca: req.marca, categoria: req.categoria, precos: req.precos, dimensoes: req.dimensoes,
    estoque: tracked ? { controlar: true, inicial: req.estoqueInicial } : undefined,
    anexos: req.imagens?.map(url => ({ url, externo: true })), grade: req.grade,
    variacoes: req.tipo === 'V' ? variations.map(v => ({ sku: v.sku, gtin: v.gtin, precos: v.precos, estoque: v.estoqueInicial !== undefined ? { controlar: true, inicial: v.estoqueInicial } : undefined, grade: v.grade })) : undefined };
  return { kind: 'product', summary: `Cadastrar produto ${req.sku} — ${req.descricao}${variations.length ? ` (${variations.length} variações)` : ''}`, risks, request: req,
    items: [{ operation: 'product_create', target: { idProduto: 0, sku: req.sku }, before: null, after: JSON.parse(JSON.stringify(payload)),
      status: problems.length ? 'invalid' : 'pending', message: problems.join('; ') || undefined }] };
}

export async function planVariationCreate(reader: ReadAdapter, req: z.infer<typeof variationCreateRequest>): Promise<Plan> {
  const parent = await readProduct(reader, req.idProduto);
  const problems: string[] = [], risks: string[] = ['A nova variação não é publicada automaticamente; confira no painel da Olist se os anúncios do pai a incluem.'];
  if (parent.tipoVariacao !== 'P') problems.push(`Produto ${req.idProduto} não é produto pai com variações (tipoVariacao=${parent.tipoVariacao ?? '?'})`);
  const keys = parent.variacoes?.find(v => v.grade?.length)?.grade?.map(g => g.chave);
  if (keys && !sameKeys(req.grade.map(g => g.chave), keys)) problems.push(`Chaves da grade devem ser exatamente ${keys.join(', ')}`);
  if (!keys) risks.push('Não foi possível ler a grade das variações existentes; o ERP validará as chaves.');
  if (req.estoqueInicial !== undefined && !parent.estoque?.controlar) risks.push('O produto pai está com "controlar estoque" desligado; a Olist pode ignorar o estoque inicial da variação.');
  const combo = (g: { chave: string; valor: string }[]) => [...g].sort((a, b) => a.chave.localeCompare(b.chave)).map(x => `${x.chave}=${x.valor}`).join('|');
  if (parent.variacoes?.some(v => v.grade && combo(v.grade) === combo(req.grade))) problems.push('Já existe variação com essa combinação de grade');
  if ((await skusInUse(reader, [req.sku])).length) problems.push(`SKU ${req.sku} já cadastrado no ERP`);
  const { idProduto, estoqueInicial, ...rest } = req;
  return { kind: 'product', summary: `Nova variação ${req.sku} em ${parent.sku ?? idProduto} (${req.grade.map(g => `${g.chave}: ${g.valor}`).join(', ')})`, risks, request: req,
    items: [{ operation: 'variation_create', target: { idProduto, sku: req.sku }, before: { variacoesExistentes: parent.variacoes?.length ?? 0 },
      after: JSON.parse(JSON.stringify({ ...rest, estoque: estoqueInicial !== undefined ? { controlar: true, inicial: estoqueInicial } : undefined })),
      status: problems.length ? 'invalid' : 'pending', message: problems.join('; ') || undefined }] };
}

// ---------- Imagens (POST /produtos/{id}/anexos: só acrescenta) ----------
const imageUrl = z.string().url().startsWith('https://').max(2000);
export const imagesRequest = z.object({
  itens: z.array(z.object({ idProduto: s.id.describe('ID do produto ou da VARIAÇÃO que receberá as imagens'), imagens: z.array(imageUrl).min(1).max(10) }).strict()).min(1).max(50)
}).strict();
export const attachments = z.array(z.object({ id: z.number().nullable().optional(), url: z.string().nullable().optional(), externo: z.boolean().nullable().optional() }));
export async function planImagesAdd(reader: ReadAdapter, req: z.infer<typeof imagesRequest>): Promise<Plan> {
  const items: ItemPlan[] = [], risks = ['As imagens são vinculadas por URL externa; a integração do canal precisa conseguir baixá-las.'];
  for (const it of req.itens) {
    const target = { idProduto: it.idProduto, sku: null as string | null };
    try {
      const p = await readProduct(reader, it.idProduto);
      target.sku = p.sku ?? null;
      const current = attachments.parse(await reader.get(`/produtos/${it.idProduto}/anexos`)).map(a => a.url).filter((u): u is string => !!u);
      const fresh = [...new Set(it.imagens)].filter(u => !current.includes(u));
      items.push({ operation: 'images_add', target, before: { imagens: current.length, urls: current.slice(0, 20) }, after: { imagens: fresh },
        status: fresh.length ? 'pending' : 'skipped', message: fresh.length ? undefined : 'Todas as imagens já estão cadastradas' });
    } catch (error) {
      items.push({ operation: 'images_add', target, before: null, after: { imagens: it.imagens }, status: 'invalid', message: error instanceof Error && /^Olist HTTP/.test(error.message) ? error.message : 'Falha ao consultar o produto' });
    }
  }
  return { kind: 'product', summary: `Adicionar imagens em ${req.itens.length} produto(s)/variação(ões)`, risks, items, request: req };
}

// ---------- Exclusão (DELETE /produtos/{id}, DELETE /produtos/{id}/variacoes/{idVariacao}) ----------
export const MAX_DELETE_ITEMS = 5, MAX_DELETE_VARIATIONS = 10;
export const deleteRequest = z.object({
  itens: z.array(z.object({
    idProduto: s.id.describe('ID do produto (ou do produto PAI quando idVariacao for informado)'),
    idVariacao: s.id.optional().describe('Informe para excluir só esta variação'),
    incluirVariacoes: z.boolean().default(false).describe('Obrigatório para excluir um produto pai: todas as variações serão excluídas juntas'),
    excluirImagens: z.boolean().default(true).describe('Excluir também as imagens/anexos vinculados ao produto')
  }).strict()).min(1).max(MAX_DELETE_ITEMS),
  motivo: z.string().trim().min(3).max(200).describe('Motivo da exclusão (fica na auditoria)')
}).strict();

// Throws when stock cannot be read: a deletion must never skip the reservation check.
async function stockOf(reader: ReadAdapter, id: number) {
  const st = await readStock(reader, id);
  return { fisico: st.saldo ?? 0, reservado: st.reservado ?? 0 };
}
export async function planDelete(reader: ReadAdapter, lookups: PlanLookups, req: z.infer<typeof deleteRequest>): Promise<Plan> {
  const items: ItemPlan[] = [];
  const risks = ['EXCLUSÃO IRREVERSÍVEL: a API da Olist não permite desfazer. Um retrato do cadastro fica guardado na auditoria.',
    'Anúncios nos marketplaces ligados a este produto podem ser pausados, excluídos ou ficar órfãos conforme a integração.'];
  const seen = new Set<string>();
  for (const it of req.itens) {
    const key = `${it.idProduto}:${it.idVariacao ?? ''}`;
    const operation = it.idVariacao ? 'variation_delete' : 'product_delete';
    const target = { idProduto: it.idProduto, idVariacao: it.idVariacao, sku: null as string | null };
    const fail = (message: string, before: Record<string, unknown> | null = null) => items.push({ operation, target, before, after: { excluir: true }, status: 'invalid', message });
    if (seen.has(key)) { fail('Item repetido na solicitação'); continue; }
    seen.add(key);
    try {
      const product = await readProduct(reader, it.idProduto);
      if (it.idVariacao) {
        const v = product.variacoes?.find(x => x.id === it.idVariacao);
        if (!v) { fail(`Variação ${it.idVariacao} não pertence ao produto ${it.idProduto}`); continue; }
        target.sku = v.sku ?? null;
        const st = await stockOf(reader, it.idVariacao);
        const before = { sku: v.sku, descricao: v.descricao ?? product.descricao, produtoPai: product.sku, grade: v.grade ?? null, precos: v.precos ?? null, estoque: st,
          variacoesRestantes: (product.variacoes?.length ?? 1) - 1 };
        const listings = await lookups.listings(it.idProduto);
        if (st && st.reservado > 0) { fail(`Há ${st.reservado} unidade(s) reservada(s) (pedidos em aberto); conclua ou cancele os pedidos antes`, before); continue; }
        if (st && st.fisico > 0) risks.push(`Variação ${v.sku}: ainda tem ${st.fisico} unidade(s) em estoque físico, que deixarão de ser controladas.`);
        if (before.variacoesRestantes === 0) risks.push(`${product.sku}: esta é a última variação; o produto pai ficará sem variações.`);
        if (listings.length) risks.push(`${product.sku}: ${listings.length} anúncio(s) vinculado(s) localmente.`);
        items.push({ operation, target, before, after: { excluir: true }, status: 'pending' });
        continue;
      }
      target.sku = product.sku ?? null;
      const variations = product.variacoes ?? [];
      const listings = await lookups.listings(it.idProduto);
      const st = product.tipoVariacao === 'P' ? null : await stockOf(reader, it.idProduto);
      const varStocks = [];
      if (product.tipoVariacao === 'P' && variations.length <= MAX_DELETE_VARIATIONS) for (const v of variations) if (v.id) varStocks.push({ sku: v.sku, ...(await stockOf(reader, v.id)) });
      const before = { sku: product.sku, descricao: product.descricao, tipoVariacao: product.tipoVariacao, situacao: product.situacao, precos: product.precos ?? null,
        estoque: st, variacoes: variations.map(v => ({ id: v.id, sku: v.sku, grade: v.grade ?? null })), estoqueVariacoes: varStocks };
      if (product.tipoVariacao === 'V') { fail(`ID ${it.idProduto} é uma variação; informe o produto pai em idProduto e este ID em idVariacao`, before); continue; }
      if (variations.length && !it.incluirVariacoes) { fail(`Produto pai com ${variations.length} variação(ões); confirme com incluirVariacoes=true ou exclua variações individualmente`, before); continue; }
      if (variations.length > MAX_DELETE_VARIATIONS) { fail(`Exclusão em massa bloqueada: ${variations.length} variações (máximo ${MAX_DELETE_VARIATIONS} por produto)`, before); continue; }
      const reserved = (st?.reservado ?? 0) + varStocks.reduce((a, v) => a + (v.reservado ?? 0), 0);
      if (reserved > 0) { fail(`Há ${reserved} unidade(s) reservada(s) (pedidos em aberto); conclua ou cancele os pedidos antes`, before); continue; }
      if (listings.length) { fail(`${listings.length} anúncio(s) vinculado(s) localmente (${listings.slice(0, 5).map(l => `${l.provider}:${l.listing_id}`).join(', ')}); encerre os anúncios antes de excluir`, before); continue; }
      const physical = (st?.fisico ?? 0) + varStocks.reduce((a, v) => a + (v.fisico ?? 0), 0);
      if (physical > 0) risks.push(`${product.sku}: ainda tem ${physical} unidade(s) em estoque físico, que deixarão de ser controladas.`);
      if (variations.length) risks.push(`${product.sku}: as ${variations.length} variações (${variations.map(v => v.sku).join(', ')}) serão excluídas junto.`);
      items.push({ operation, target, before, after: { excluir: true, excluirAnexosVinculados: it.excluirImagens }, status: 'pending' });
    } catch (error) {
      fail(error instanceof Error && /^Olist HTTP 404/.test(error.message) ? 'Produto não encontrado (já excluído?)' : error instanceof Error && /^Olist HTTP/.test(error.message) ? error.message
        : 'Não foi possível conferir produto/estoque; exclusão bloqueada por segurança');
    }
  }
  const skus = items.map(i => i.target.sku ?? i.target.idProduto).join(', ');
  return { kind: 'product', summary: `EXCLUIR ${items.length} item(ns): ${skus}`.slice(0, 300), risks: [...new Set(risks)], items, request: req };
}

// Resolve SKU to exactly one Olist ID; ambiguity is an error, never a guess.
export async function resolveSku(reader: ReadAdapter, sku: string): Promise<{ id?: number; error?: string }> {
  const found = s.productList.parse(await reader.get('/produtos', { codigo: sku, limit: 100, offset: 0 })).itens.filter(p => p.sku === sku && p.id);
  if (found.length === 1) return { id: found[0]!.id! };
  return { error: found.length ? `SKU duplicado no ERP (IDs ${found.map(p => p.id).join(', ')}); informe idProduto` : 'SKU não encontrado no ERP' };
}
