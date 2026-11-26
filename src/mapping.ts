import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool } from './db.ts';
import type { ReadAdapter } from './adapters/contracts.ts';
import { marketplaceProviders } from './adapters/contracts.ts';
import * as s from './schemas.ts';
const externalId = z.string().trim().min(1).max(100).regex(/^[\w.:\-/]+$/);
export const listingInput = z.object({
  provider: z.enum(marketplaceProviders), storeId: externalId.optional(),
  listingId: externalId, marketplaceProductId: externalId.optional(), marketplaceVariationId: externalId.optional(),
  olistProductId: s.id, olistParentId: s.id.optional(), idDeposito: s.id.optional(),
  syncPolicy: z.enum(['olist_master', 'marketplace_master', 'manual', 'disabled']).default('olist_master')
}).strict();

// Local mapping only: never changes anything in the ERP or marketplace. SKU is stored as observed, never used as key.
export async function linkListing(pool: Pool, reader: ReadAdapter, account: string, input: z.infer<typeof listingInput>) {
  const product = s.product.parse(await reader.get(`/produtos/${input.olistParentId ?? input.olistProductId}`));
  const variation = input.olistParentId ? product.variacoes?.find(v => v.id === input.olistProductId) : undefined;
  if (input.olistParentId && !variation) throw new Error('Variação não pertence ao produto pai informado');
  const row = await pool.query(`INSERT INTO channel_listings(id,account_id,olist_product_id,olist_parent_id,sku,variation_sku,provider,store_id,
      marketplace_product_id,listing_id,marketplace_variation_id,deposit_id,sync_policy,source)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'manual')
    ON CONFLICT(account_id,provider,store_id,listing_id,marketplace_variation_id) DO UPDATE SET olist_product_id=EXCLUDED.olist_product_id,
      olist_parent_id=EXCLUDED.olist_parent_id,sku=EXCLUDED.sku,variation_sku=EXCLUDED.variation_sku,marketplace_product_id=EXCLUDED.marketplace_product_id,
      deposit_id=EXCLUDED.deposit_id,sync_policy=EXCLUDED.sync_policy,updated_at=now()
    RETURNING *`, [randomUUID(), account, input.olistProductId, input.olistParentId ?? null, product.sku ?? null, variation?.sku ?? null, input.provider,
    input.storeId ?? '', input.marketplaceProductId ?? null, input.listingId, input.marketplaceVariationId ?? '', input.idDeposito ?? null, input.syncPolicy]);
  return row.rows[0];
}
export async function listListings(pool: Pool, account: string, f: { olistProductId?: number; sku?: string; provider?: string; limit: number; offset: number }) {
  const rows = await pool.query(`SELECT * FROM channel_listings WHERE account_id=$1 AND ($2::bigint IS NULL OR olist_product_id=$2 OR olist_parent_id=$2)
    AND ($3::text IS NULL OR sku=$3 OR variation_sku=$3) AND ($4::text IS NULL OR provider=$4) ORDER BY provider,listing_id LIMIT $5 OFFSET $6`,
  [account, f.olistProductId ?? null, f.sku ?? null, f.provider ?? null, f.limit, f.offset]);
  return rows.rows;
}
export async function listingsFor(pool: Pool, account: string, olistProductId: number) {
  return (await pool.query(`SELECT provider,listing_id,store_id,marketplace_variation_id,sync_policy,listing_status,observed_stock,observed_price,observed_at
    FROM channel_listings WHERE account_id=$1 AND (olist_product_id=$2 OR olist_parent_id=$2)`, [account, olistProductId])).rows;
}

// Read-only reconciliation: reports divergences and suggestions; applying them is a separate explicit step.
export async function reconcile(pool: Pool, reader: ReadAdapter, account: string, limit: number) {
  const listings = (await pool.query(`SELECT id,provider,store_id,listing_id,marketplace_variation_id,olist_product_id,olist_parent_id,sku,variation_sku
    FROM channel_listings WHERE account_id=$1 AND sync_policy<>'disabled' ORDER BY updated_at LIMIT $2`, [account, limit])).rows;
  const findings: { listing: string; problema: string; evidencia: string; sugestao: string }[] = [];
  for (const l of listings) {
    const key = `${l.provider}:${l.store_id || '-'}:${l.listing_id}${l.marketplace_variation_id ? '/' + l.marketplace_variation_id : ''}`;
    try {
      const parent = s.product.parse(await reader.get(`/produtos/${l.olist_parent_id ?? l.olist_product_id}`));
      const current = l.olist_parent_id ? parent.variacoes?.find(v => v.id === Number(l.olist_product_id)) : parent;
      if (!current) findings.push({ listing: key, problema: 'Variação não encontrada no produto pai', evidencia: `ID ${l.olist_product_id}`, sugestao: 'Revincular à variação correta' });
      else if ((current.sku ?? null) !== (l.olist_parent_id ? l.variation_sku : l.sku))
        findings.push({ listing: key, problema: 'SKU do ERP mudou desde o vínculo', evidencia: `vinculado=${l.olist_parent_id ? l.variation_sku : l.sku} atual=${current.sku}`, sugestao: 'Confirmar o vínculo com mapping_link' });
      if (parent.tipoVariacao === 'P' && !l.olist_parent_id && !l.marketplace_variation_id && (parent.variacoes?.length ?? 0) > 0)
        findings.push({ listing: key, problema: 'Anúncio vinculado ao produto pai com variações', evidencia: `${parent.variacoes!.length} variações no ERP`, sugestao: 'Vincular cada variação do anúncio à variação Olist' });
    } catch (error) {
      findings.push({ listing: key, problema: 'Produto Olist inacessível', evidencia: error instanceof Error && /^Olist HTTP/.test(error.message) ? error.message : 'erro de leitura', sugestao: 'Verificar se o produto foi excluído ou se a permissão foi revogada' });
    }
  }
  const duplicates = (await pool.query(`SELECT provider,store_id,listing_id,count(DISTINCT olist_product_id)::int AS produtos FROM channel_listings
    WHERE account_id=$1 GROUP BY 1,2,3 HAVING count(DISTINCT olist_product_id)>1 AND count(DISTINCT marketplace_variation_id)=1`, [account])).rows;
  for (const d of duplicates) findings.push({ listing: `${d.provider}:${d.store_id || '-'}:${d.listing_id}`, problema: 'Anúncio sem variação vinculado a vários produtos', evidencia: `${d.produtos} produtos`, sugestao: 'Manter apenas um vínculo' });
  return { verificados: listings.length, achados: findings };
}
