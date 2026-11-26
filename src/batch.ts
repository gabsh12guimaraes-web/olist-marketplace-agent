import { z } from 'zod';
import type { ReadAdapter } from './adapters/contracts.ts';
import { planPriceItems, planSkuItem, planStockItem, resolveSku, skuRequest, type ItemPlan, type Plan, type PlanLimits, type PlanLookups } from './planners.ts';
import { parseNumber, type Row } from './spreadsheet.ts';
export const batchRequest = z.object({
  arquivo: z.string(), linhas: z.array(z.record(z.string())),
  alvoEstoquePadrao: z.enum(['fisico', 'disponivel']).optional(),
  aceitarVariacaoAlta: z.boolean().default(false)
});
export type BatchRequest = z.infer<typeof batchRequest>;
const recoverable = (e: unknown) => e instanceof Error && /Rate limited|HTTP 429|unavailable|timed out/.test(e.message);
const DIRECT_CHANNELS_DISABLED = 'Escrita direta no marketplace não habilitada; altere no ERP Olist, que sincroniza o canal conforme a integração.';

// Validates every row independently: one bad row never blocks the others, and every row gets an explicit result.
export async function planBatch(reader: ReadAdapter, lookups: PlanLookups, limits: PlanLimits & { maxItems: number }, request: BatchRequest): Promise<Plan> {
  const items: ItemPlan[] = [], risks: string[] = [], seen = new Set<string>();
  const rows = request.linhas;
  if (rows.length > limits.maxItems) risks.push(`Somente as primeiras ${limits.maxItems} linhas foram consideradas (MAX_BATCH_ITEMS).`);
  for (const [index, row] of rows.slice(0, limits.maxItems).entries()) {
    const linha = index + 2; // header is line 1
    const fail = (message: string, operation: ItemPlan['operation'] = 'stock_balance', status: ItemPlan['status'] = 'invalid') =>
      items.push({ operation, target: { idProduto: Number(row.idProduto) || 0, sku: row.sku || null, linha }, before: null, after: {}, status, message });
    try {
      if (row.marketplace && !/^(olist|erp|todos)?$/i.test(row.marketplace)) { fail(DIRECT_CHANNELS_DISABLED, 'stock_balance', 'skipped'); continue; }
      if (row.alteracao && /exclu|delet|remov|apag/i.test(row.alteracao)) { fail('Exclusões não são permitidas por lote'); continue; }
      const estoque = parseNumber(row.estoque), preco = parseNumber(row.preco), promo = parseNumber(row.precoPromocional);
      const idVariacao = parseNumber(row.idVariacao), idDeposito = parseNumber(row.idDeposito);
      if ([estoque, preco, promo, idVariacao, idDeposito].some(v => Number.isNaN(v))) { fail('Valor numérico inválido'); continue; }
      const novoSku = row.novoSku?.trim() || undefined;
      if (estoque === undefined && preco === undefined && novoSku === undefined) { fail('Linha sem estoque, preço ou SKU novo'); continue; }
      let idProduto = parseNumber(row.idProduto);
      if (idProduto === undefined || Number.isNaN(idProduto)) {
        if (!row.sku) { fail('Informe sku ou idProduto'); continue; }
        const resolved = await resolveSku(reader, row.sku);
        if (!resolved.id) { fail(resolved.error!); continue; }
        idProduto = resolved.id;
      }
      if (!Number.isSafeInteger(idProduto) || idProduto <= 0) { fail('idProduto inválido'); continue; }
      if (estoque !== undefined) {
        const key = `s:${idProduto}:${idDeposito ?? ''}`;
        const alvo = (row.alvo ? row.alvo.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '') : request.alvoEstoquePadrao) as 'fisico' | 'disponivel' | undefined;
        if (seen.has(key)) fail('Estoque do mesmo produto/depósito repetido na planilha');
        else if (alvo !== 'fisico' && alvo !== 'disponivel') fail('Informe alvo (fisico ou disponivel) na coluna alvo ou em alvoEstoquePadrao');
        else if (estoque < 0) fail('Estoque desejado negativo');
        else {
          seen.add(key);
          const planned = await planStockItem(reader, { idProduto, quantidade: estoque, alvo, idDeposito, permitirDisponivelNegativo: false, observacao: `Lote ${request.arquivo} linha ${linha}`.slice(0, 200) }, linha);
          items.push(planned.item); risks.push(...planned.risks);
        }
      }
      if (preco !== undefined) {
        const key = `p:${idProduto}:${idVariacao ?? ''}`;
        if (seen.has(key)) { fail('Preço do mesmo produto repetido na planilha', 'price'); continue; }
        seen.add(key);
        const planned = await planPriceItems(reader, lookups, limits, { itens: [{ idProduto, idVariacao, preco, precoPromocional: promo }], aceitarVariacaoAlta: request.aceitarVariacaoAlta });
        for (const item of planned.items) items.push({ ...item, target: { ...item.target, linha } });
        risks.push(...planned.risks);
      }
      if (novoSku !== undefined) {
        const parsed = skuRequest.safeParse({ idProduto, novoSku });
        if (!parsed.success) { fail('SKU novo inválido (até 60 caracteres: letras, números, - _ . /)', 'sku_update'); continue; }
        if (seen.has(`k:${idProduto}`)) { fail('SKU do mesmo produto repetido na planilha', 'sku_update'); continue; }
        if (seen.has(`n:${novoSku}`)) { fail(`SKU novo ${novoSku} repetido na planilha`, 'sku_update'); continue; }
        seen.add(`k:${idProduto}`); seen.add(`n:${novoSku}`);
        items.push(await planSkuItem(reader, lookups, limits, parsed.data, linha));
      }
    } catch (error) {
      if (recoverable(error)) throw error;
      fail(error instanceof Error && /^Olist HTTP/.test(error.message) ? error.message : 'Falha ao validar a linha');
    }
  }
  const count = (st: string) => items.filter(i => i.status === st).length;
  return { kind: 'batch', request, risks: [...new Set(risks)].slice(0, 50), items,
    summary: `Lote ${request.arquivo}: ${rows.length} linha(s) — ${count('pending')} executável(is), ${count('invalid')} com erro, ${count('skipped')} omitida(s)` };
}
export type { Row };
