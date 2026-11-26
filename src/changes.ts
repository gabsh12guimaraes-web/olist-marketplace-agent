import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Pool } from './db.ts';
import type { ReadAdapter, WriteAdapter } from './adapters/contracts.ts';
import { OlistWriteUnknown } from './adapters/olist.ts';
import { digest, nonce } from './security.ts';
import * as s from './schemas.ts';
import { attachments, type ItemPlan, type Operation, type Plan } from './planners.ts';

const permissionOf: Record<Operation, Config['WRITE_OPERATIONS'][number]> = { stock_balance: 'stock', price: 'price', product_update: 'product', sku_update: 'sku', product_create: 'create', variation_create: 'create', images_add: 'product', product_delete: 'delete', variation_delete: 'delete' };
const OPEN = ['preparing', 'pending', 'executing'];
export interface ChangeDeps {
  pool: Pool; config: Config; reader: ReadAdapter; writer: WriteAdapter;
  // Batch spreadsheets are planned in the background because the ERP read budget is small.
  planBatch?(request: unknown): Promise<Plan>;
}
export interface ItemRow { seq: number; operation: Operation; target: ItemPlan['target']; before: Record<string, unknown> | null; after: Record<string, unknown>; status: string; message: string | null; verified: boolean | null; executed_at: Date | null }
export class ChangeError extends Error { readonly code: string; constructor(code: string, message: string) { super(message); this.code = code; } }

export class ChangeService {
  readonly d: ChangeDeps; readonly account: string;
  constructor(d: ChangeDeps) { this.d = d; this.account = d.config.OLIST_ACCOUNT_ID; }

  async audit(tool: string, kind: string, proposalId: string | null, outcome: 'success' | 'error', details: Record<string, unknown> = {}, requestId = randomUUID()) {
    await this.d.pool.query(`INSERT INTO audit_events(id,account_id,tool,request_id,outcome,kind,proposal_id,details,finished_at,error_code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)`, [randomUUID(), this.account, tool, requestId, outcome, kind, proposalId, details, typeof details.code === 'string' ? details.code : null]);
  }

  // Same open request twice returns the existing proposal instead of creating a duplicate.
  async create(plan: Plan, fingerprintSource: unknown = { kind: plan.kind, items: plan.items.map(i => [i.operation, i.target.idProduto, i.target.idVariacao, i.target.idDeposito, i.after]) }) {
    const fingerprint = digest(JSON.stringify(fingerprintSource));
    // An expired proposal must not block preparing the same request again.
    await this.d.pool.query(`UPDATE change_proposals SET status='expired' WHERE account_id=$1 AND fingerprint=$2 AND status='pending' AND expires_at<=now()`, [this.account, fingerprint]);
    const existing = await this.d.pool.query(`SELECT id FROM change_proposals WHERE account_id=$1 AND fingerprint=$2 AND status = ANY($3)`, [this.account, fingerprint, OPEN]);
    if (existing.rows[0]) return { ...(await this.view(existing.rows[0].id)), duplicada: true };
    const id = randomUUID();
    const executable = plan.items.filter(i => i.status === 'pending').length;
    const preparing = plan.kind === 'batch' && plan.items.length === 0 && !plan.blocked;
    const status = preparing ? 'preparing' : plan.blocked || executable === 0 ? 'blocked' : 'pending';
    const blockedReason = plan.blocked ?? (status === 'blocked' ? 'Nenhum item executável após validação' : null);
    const code = this.d.config.APPROVAL_MODE === 'client' && status === 'pending' ? nonce().slice(0, 10) : undefined;
    const client = await this.d.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO change_proposals(id,account_id,kind,status,summary,risks,blocked_reason,request,fingerprint,confirmation_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+($11*interval '1 minute'))`,
      [id, this.account, plan.kind, status, plan.summary, JSON.stringify(plan.risks), blockedReason, plan.request, fingerprint, code ? digest(code) : null, this.d.config.PROPOSAL_TTL_MINUTES]);
      await insertItems(client, id, plan.items);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505') { // concurrent identical prepare
        const again = await this.d.pool.query(`SELECT id FROM change_proposals WHERE account_id=$1 AND fingerprint=$2 AND status = ANY($3)`, [this.account, fingerprint, OPEN]);
        if (again.rows[0]) return { ...(await this.view(again.rows[0].id)), duplicada: true };
      }
      throw error;
    } finally { client.release(); }
    await this.audit(`prepare_${plan.kind}`, 'prepare', id, 'success', { status, items: plan.items.length });
    return { ...(await this.view(id)), ...(code ? { codigoConfirmacao: code } : {}) };
  }

  async view(id: string) {
    const p = await this.d.pool.query(`SELECT id,kind,status,summary,risks,blocked_reason,created_at,expires_at,approved_at,approved_by,started_at,finished_at
      FROM change_proposals WHERE id=$1 AND account_id=$2`, [id, this.account]);
    if (!p.rows[0]) throw new ChangeError('NOT_FOUND', 'Proposta não encontrada');
    const items = (await this.d.pool.query(`SELECT seq,operation,target,before,after,status,message,verified,executed_at FROM change_items WHERE proposal_id=$1 ORDER BY seq`, [id])).rows as ItemRow[];
    const totals: Record<string, number> = {};
    for (const i of items) totals[i.status] = (totals[i.status] ?? 0) + 1;
    const row = p.rows[0] as { id: string; status: string; summary: string; risks: string[]; blocked_reason: string | null; expires_at: Date } & Record<string, unknown>;
    const expired = row.status === 'pending' && new Date(row.expires_at) <= new Date();
    return { ...row, status: expired ? 'expired' : row.status, totais: totals, itens: items,
      proximoPasso: nextStep(expired ? 'expired' : row.status, this.d.config) };
  }

  async list(filter: { status?: string; since?: string; limit: number }) {
    const rows = await this.d.pool.query(`SELECT id,kind,status,summary,created_at,expires_at,finished_at FROM change_proposals
      WHERE account_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::timestamptz IS NULL OR created_at >= $3)
      ORDER BY created_at DESC LIMIT $4`, [this.account, filter.status ?? null, filter.since ?? null, filter.limit]);
    return rows.rows;
  }

  missingPermissions(items: { operation: Operation; status: string }[]) {
    if (this.d.config.WRITE_MODE !== 'enabled') return ['WRITE_MODE=enabled'];
    const needed = [...new Set(items.filter(i => i.status === 'pending').map(i => permissionOf[i.operation]))];
    return needed.filter(p => !this.d.config.WRITE_OPERATIONS.includes(p)).map(p => `WRITE_OPERATIONS:${p}`);
  }

  // The only path to execution. Validated by the server: status, expiry, block, permissions and approver.
  async approve(id: string, approver: 'admin' | 'client', confirmationCode?: string) {
    const p = await this.d.pool.query('SELECT status,expires_at,confirmation_hash FROM change_proposals WHERE id=$1 AND account_id=$2', [id, this.account]);
    const row = p.rows[0];
    if (!row) throw new ChangeError('NOT_FOUND', 'Proposta não encontrada');
    if (approver === 'client') {
      if (this.d.config.APPROVAL_MODE !== 'client') throw new ChangeError('HUMAN_APPROVAL_REQUIRED', 'Aprovação humana exigida no painel /admin');
      if (!confirmationCode || !row.confirmation_hash || digest(confirmationCode) !== row.confirmation_hash) throw new ChangeError('INVALID_CONFIRMATION', 'Código de confirmação inválido');
    }
    if (row.status !== 'pending') throw new ChangeError('INVALID_STATUS', `Proposta em status ${row.status}`);
    if (new Date(row.expires_at) <= new Date()) {
      await this.d.pool.query("UPDATE change_proposals SET status='expired' WHERE id=$1 AND status='pending'", [id]);
      throw new ChangeError('EXPIRED', 'Proposta expirada; prepare novamente');
    }
    const items = (await this.d.pool.query('SELECT operation,status FROM change_items WHERE proposal_id=$1', [id])).rows;
    const missing = this.missingPermissions(items);
    if (missing.length) { await this.audit('approve', 'execute', id, 'error', { code: 'WRITE_NOT_PERMITTED', missing }); throw new ChangeError('WRITE_NOT_PERMITTED', `Escrita não habilitada no servidor: ${missing.join(', ')}`); }
    // Atomic transition: a second approval (double click, agent retry) affects zero rows.
    const updated = await this.d.pool.query(`UPDATE change_proposals SET status='executing',approved_at=now(),approved_by=$2
      WHERE id=$1 AND status='pending' AND expires_at>now() RETURNING id`, [id, approver]);
    if (updated.rowCount !== 1) throw new ChangeError('INVALID_STATUS', 'Proposta já processada');
    await this.audit('approve', 'execute', id, 'success', { approver });
    return this.view(id);
  }

  async reject(id: string, by: string) {
    const r = await this.d.pool.query(`UPDATE change_proposals SET status=$3,finished_at=now() WHERE id=$1 AND account_id=$2 AND status IN ('pending','preparing','blocked') RETURNING id`,
      [id, this.account, by === 'admin' ? 'rejected' : 'cancelled']);
    if (r.rowCount !== 1) throw new ChangeError('INVALID_STATUS', 'Somente propostas não executadas podem ser canceladas');
    await this.audit('cancel', 'prepare', id, 'success', { by });
    return this.view(id);
  }

  // Claims one proposal needing work. SKIP LOCKED + lease lets several instances run safely and resume after crashes.
  async runNext(budgetMs = 40_000): Promise<string | null> {
    const claimed = await this.d.pool.query(`UPDATE change_proposals SET lease_until=now()+interval '2 minutes',attempts=attempts+1,started_at=coalesce(started_at,now())
      WHERE id=(SELECT id FROM change_proposals WHERE account_id=$1 AND status IN ('preparing','executing') AND (lease_until IS NULL OR lease_until<now())
        ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id,status,request,kind`, [this.account]);
    const row = claimed.rows[0];
    if (!row) return null;
    if (row.status === 'preparing') await this.prepareBatch(row.id, row.request);
    else await this.execute(row.id, budgetMs);
    return row.id;
  }

  async runById(id: string, budgetMs: number) {
    const claimed = await this.d.pool.query(`UPDATE change_proposals SET lease_until=now()+interval '2 minutes',attempts=attempts+1,started_at=coalesce(started_at,now())
      WHERE id=$1 AND account_id=$2 AND status='executing' AND (lease_until IS NULL OR lease_until<now()) RETURNING id`, [id, this.account]);
    if (claimed.rowCount === 1) await this.execute(id, budgetMs);
    return this.view(id);
  }

  async prepareBatch(id: string, request: unknown) {
    try {
      if (!this.d.planBatch) throw new Error('Batch planner unavailable');
      const plan = await this.d.planBatch(request);
      const executable = plan.items.filter(i => i.status === 'pending').length;
      const client = await this.d.pool.connect();
      try {
        await client.query('BEGIN');
        await insertItems(client, id, plan.items);
        await client.query(`UPDATE change_proposals SET status=$2,risks=$3,summary=$4,blocked_reason=$5,lease_until=NULL,
          expires_at=now()+($6*interval '1 minute') WHERE id=$1 AND status='preparing'`,
        [id, executable ? 'pending' : 'blocked', JSON.stringify(plan.risks), plan.summary, executable ? null : 'Nenhuma linha válida', this.d.config.PROPOSAL_TTL_MINUTES]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      await this.audit('prepare_batch', 'prepare', id, 'success', { items: plan.items.length, executable });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 200) : 'erro';
      // Rate limits are recoverable: release the lease and let the worker retry later (bounded attempts).
      const attempts = (await this.d.pool.query('SELECT attempts FROM change_proposals WHERE id=$1', [id])).rows[0]?.attempts ?? 0;
      if (/Rate limited|HTTP 429|unavailable/.test(message) && attempts < 5) await this.d.pool.query("UPDATE change_proposals SET lease_until=now()+interval '1 minute' WHERE id=$1", [id]);
      else await this.d.pool.query("UPDATE change_proposals SET status='failed',blocked_reason=$2,finished_at=now() WHERE id=$1", [id, message]);
      await this.audit('prepare_batch', 'prepare', id, 'error', { code: 'BATCH_PREPARE_FAILED' });
    }
  }

  async execute(id: string, budgetMs: number) {
    const started = Date.now();
    const items = (await this.d.pool.query(`SELECT seq,operation,target,before,after,status,message,verified,executed_at FROM change_items
      WHERE proposal_id=$1 AND status='pending' ORDER BY seq`, [id])).rows as ItemRow[];
    // Re-check permissions at execution: config may have changed after approval.
    const missing = this.missingPermissions(items);
    if (missing.length) {
      await this.d.pool.query("UPDATE change_proposals SET status='failed',blocked_reason=$2,finished_at=now(),lease_until=NULL WHERE id=$1", [id, `Escrita desabilitada: ${missing.join(', ')}`]);
      return;
    }
    for (const item of items) {
      if (Date.now() - started > budgetMs) { await this.d.pool.query('UPDATE change_proposals SET lease_until=NULL WHERE id=$1', [id]); return; }
      await this.d.pool.query("UPDATE change_proposals SET lease_until=now()+interval '2 minutes' WHERE id=$1", [id]);
      const result = await this.executeItem(id, item);
      await this.d.pool.query(`UPDATE change_items SET status=$3,message=$4,verified=$5,response=$6,executed_at=coalesce(executed_at,now()) WHERE proposal_id=$1 AND seq=$2`,
        // Serialize explicitly: node-postgres would send a JS array as a Postgres array literal, not JSON.
        [id, item.seq, result.status, result.message ?? null, result.verified ?? null, result.response === undefined || result.response === null ? null : JSON.stringify(result.response)]);
      await this.audit(item.operation, 'execute', id, ['succeeded'].includes(result.status) ? 'success' : 'error',
        { seq: item.seq, idProduto: item.target.idProduto, status: result.status, verified: result.verified ?? null, ...(result.status !== 'succeeded' ? { code: result.status.toUpperCase() } : {}) });
    }
    const counts = (await this.d.pool.query('SELECT status,count(*)::int AS n FROM change_items WHERE proposal_id=$1 GROUP BY status', [id])).rows as { status: string; n: number }[];
    const n = (st: string) => counts.find(c => c.status === st)?.n ?? 0;
    const bad = n('failed') + n('conflict') + n('unknown');
    const final = bad === 0 ? 'succeeded' : n('succeeded') > 0 ? 'partial' : 'failed';
    await this.d.pool.query('UPDATE change_proposals SET status=$2,finished_at=now(),lease_until=NULL WHERE id=$1', [id, final]);
  }

  async executeItem(_id: string, item: ItemRow): Promise<{ status: 'succeeded' | 'failed' | 'conflict' | 'unknown'; message?: string; verified?: boolean; response?: unknown }> {
    const { target, before, after } = item;
    try {
      // An executed_at without final status means a crash after sending: never resend, only verify.
      const resumed = item.executed_at !== null;
      if (!resumed) await this.d.pool.query("UPDATE change_items SET executed_at=now(),message='enviando' WHERE proposal_id=$1 AND seq=$2", [_id, item.seq]);
      if (item.operation === 'stock_balance') {
        const read = async () => { const st = s.stock.parse(await this.d.reader.get(`/estoque/${target.idProduto}`)); return st.depositos?.find(d => d.id === target.idDeposito); };
        const reached = async () => (await read())?.saldo === after.quantidade;
        if (resumed) return (await reached()) ? { status: 'succeeded', verified: true, message: 'Verificado após retomada' } : { status: 'unknown', message: 'Envio interrompido; saldo não confere. Confira no ERP antes de repetir.' };
        const dep = await read();
        if (!dep || dep.saldo !== before?.saldoDeposito || (after.alvo === 'disponivel' && (dep.reservado ?? null) !== (before?.reservadoDeposito ?? null)))
          return { status: 'conflict', message: `Estoque mudou desde a prévia (saldo atual ${dep?.saldo ?? '?'}, reservado ${dep?.reservado ?? '?'}). Prepare novamente.` };
        return await this.sendAndVerify('POST', `/estoque/${target.idProduto}`,
          { deposito: after.deposito, tipo: 'B', quantidade: after.quantidade, precoUnitario: after.precoUnitario ?? null, observacoes: after.observacoes }, reached);
      }
      if (item.operation === 'price') {
        const read = async () => { const p = s.product.parse(await this.d.reader.get(`/produtos/${target.idProduto}`)); const node = target.idVariacao ? p.variacoes?.find(v => v.id === target.idVariacao) : p; return node?.precos; };
        const reached = async () => { const pr = await read(); return pr?.preco === after.preco && (pr?.precoPromocional ?? null) === (after.precoPromocional ?? null); };
        if (resumed) return (await reached()) ? { status: 'succeeded', verified: true, message: 'Verificado após retomada' } : { status: 'unknown', message: 'Envio interrompido; preço não confere.' };
        const pr = await read();
        if ((pr?.preco ?? null) !== before?.preco || (pr?.precoPromocional ?? null) !== (before?.precoPromocional ?? null))
          return { status: 'conflict', message: `Preço mudou desde a prévia (atual ${pr?.preco ?? '?'}). Prepare novamente.` };
        const path = target.idVariacao ? `/produtos/${target.idProduto}/variacoes/${target.idVariacao}/preco` : `/produtos/${target.idProduto}/preco`;
        return await this.sendAndVerify('PUT', path, { preco: after.preco, precoPromocional: after.precoPromocional ?? null }, reached);
      }
      if (item.operation === 'product_delete' || item.operation === 'variation_delete') {
        const isVariation = item.operation === 'variation_delete';
        // Gone = 404, or the ERP moved it to "excluído" (situacao E), or the variation is no longer under its parent.
        const gone = async () => {
          try {
            const p = s.product.parse(await this.d.reader.get(`/produtos/${target.idProduto}`));
            return isVariation ? !(p.variacoes ?? []).some(v => v.id === target.idVariacao) : p.situacao === 'E';
          } catch (error) { if (error instanceof Error && /^Olist HTTP 404/.test(error.message)) return true; throw error; }
        };
        if (resumed) return (await gone()) ? { status: 'succeeded', verified: true, message: 'Exclusão confirmada após retomada' } : { status: 'unknown', message: 'Envio interrompido; confira no ERP antes de repetir.' };
        if (await gone()) return { status: 'succeeded', verified: true, message: 'Já estava excluído' };
        // Re-check the same safety rules as the preview: identity unchanged and no reservations appeared since.
        const p = s.product.parse(await this.d.reader.get(`/produtos/${target.idProduto}`));
        const node = isVariation ? p.variacoes?.find(v => v.id === target.idVariacao) : p;
        if ((node?.sku ?? null) !== (before?.sku ?? null)) return { status: 'conflict', message: `O SKU mudou desde a prévia (${before?.sku} → ${node?.sku}). Nada foi excluído.` };
        const ids = isVariation ? [target.idVariacao!] : p.tipoVariacao === 'P' ? (p.variacoes ?? []).map(v => v.id!).filter(Boolean) : [target.idProduto];
        if (!isVariation && (p.variacoes?.length ?? 0) !== ((before?.variacoes as unknown[] | undefined)?.length ?? 0)) return { status: 'conflict', message: 'A quantidade de variações mudou desde a prévia. Nada foi excluído.' };
        for (const id of ids) {
          const st = s.stock.parse(await this.d.reader.get(`/estoque/${id}`));
          if ((st.reservado ?? 0) > 0) return { status: 'conflict', message: `Surgiu estoque reservado (${st.reservado}) desde a prévia. Nada foi excluído.` };
        }
        const path = isVariation ? `/produtos/${target.idProduto}/variacoes/${target.idVariacao}` : `/produtos/${target.idProduto}`;
        return await this.sendAndVerify('DELETE', path, isVariation ? undefined : { excluirAnexosVinculados: after.excluirAnexosVinculados !== false }, gone);
      }
      if (item.operation === 'images_add') {
        const urls = (after.imagens as string[]) ?? [];
        const current = async () => attachments.parse(await this.d.reader.get(`/produtos/${target.idProduto}/anexos`)).map(a => a.url);
        const reached = async () => { const now = await current(); return urls.every(u => now.includes(u)); };
        // Idempotent: URLs already attached are never sent again (no duplicate images on retry or resume).
        const missing = async () => { const now = await current(); return urls.filter(u => !now.includes(u)); };
        if (resumed) return (await reached()) ? { status: 'succeeded', verified: true, message: 'Verificado após retomada' } : { status: 'unknown', message: 'Envio interrompido; confira as imagens no ERP antes de repetir.' };
        const toSend = await missing();
        if (!toSend.length) return { status: 'succeeded', verified: true, message: 'Imagens já estavam cadastradas' };
        return await this.sendAndVerify('POST', `/produtos/${target.idProduto}/anexos`, toSend.map(url => ({ url, externo: true })), reached);
      }
      if (item.operation === 'product_create' || item.operation === 'variation_create') {
        const sku = String(after.sku);
        const exists = async () => {
          if (item.operation === 'product_create') return s.productList.parse(await this.d.reader.get('/produtos', { codigo: sku, limit: 100, offset: 0 })).itens.some(p => p.sku === sku);
          return (s.product.parse(await this.d.reader.get(`/produtos/${target.idProduto}`)).variacoes ?? []).some(v => v.sku === sku);
        };
        if (resumed) return (await exists()) ? { status: 'succeeded', verified: true, message: 'Verificado após retomada' } : { status: 'unknown', message: 'Envio interrompido; cadastro não encontrado. Confira no ERP antes de repetir.' };
        // Duplicate guard: someone may have created the SKU after the preview.
        if (await exists()) return { status: 'conflict', message: `SKU ${sku} passou a existir no ERP depois da prévia; nada foi criado.` };
        const path = item.operation === 'product_create' ? '/produtos' : `/produtos/${target.idProduto}/variacoes`;
        const result = await this.sendAndVerify('POST', path, after, exists);
        const created = (result.response as { id?: number } | null)?.id;
        return created ? { ...result, message: `Criado com ID ${created}${result.message ? '. ' + result.message : ''}` } : result;
      }
      // product_update / sku_update: blocked unless the full-replacement PUT was homologated (globally or on a test product).
      if (!this.d.config.OLIST_PRODUCT_PUT_VERIFIED && !this.d.config.HOMOLOGATION_PRODUCT_IDS.includes(target.idProduto)) return { status: 'failed', message: 'REQUIRES_HOMOLOGATION: PUT /produtos/{id} não homologado' };
      const raw = await this.d.reader.get(`/produtos/${target.idProduto}`) as Record<string, unknown>;
      for (const [key, value] of Object.entries(before ?? {})) if (JSON.stringify(raw[key] ?? null) !== JSON.stringify(value ?? null))
        return { status: 'conflict', message: `Campo ${key} mudou desde a prévia. Prepare novamente.` };
      // A variation answers GET /produtos/{id} but PUT /produtos/{id} returns 404 for it: it is written through its parent.
      const parent = raw.tipoVariacao === 'V' ? (raw.produtoPai as { id?: number } | null | undefined)?.id : undefined;
      if (raw.tipoVariacao === 'V' && !parent) return { status: 'failed', message: 'Variação sem produto pai na resposta da Olist; nada foi enviado.' };
      const path = parent ? `/produtos/${parent}/variacoes/${target.idProduto}` : `/produtos/${target.idProduto}`;
      // Resend the whole current record with the requested fields applied: if PUT replaces the record, nothing is dropped.
      const base = parent ? variationPutBody(raw) : productPutBody(raw);
      const body: Record<string, unknown> = { ...base };
      // Nested objects other than references (dimensoes) are merged one level deep so untouched subfields stay.
      for (const [k, v] of Object.entries(after)) body[k] = v && typeof v === 'object' && !('id' in v) ? { ...(base[k] as object ?? {}), ...v } : v;
      const same = (k: string, v: unknown, now: Record<string, unknown>) => {
        if (v && typeof v === 'object') return 'id' in v ? (now[k] as { id?: number } | null)?.id === (v as { id: number }).id
          : Object.entries(v).every(([sk, sv]) => (now[k] as Record<string, unknown> | null)?.[sk] === sv);
        return k === 'origem' ? Number(now[k]) === v : now[k] === v;
      };
      const reached = async () => { const now = await this.d.reader.get(`/produtos/${target.idProduto}`) as Record<string, unknown>;
        return Object.entries(after).every(([k, v]) => same(k, v, now)); };
      const result = await this.sendAndVerify('PUT', path, body, reached);
      // Post-check: fields the request did not touch must be unchanged.
      try {
        const now = await this.d.reader.get(`/produtos/${target.idProduto}`) as Record<string, unknown>;
        const drift = preservedDrift(raw, now, Object.keys(after));
        if (drift.length) return { ...result, message: `ATENÇÃO: campos não solicitados mudaram: ${drift.join(', ')}. Confira no ERP.` };
      } catch { /* verification read failed; result already reflects the write */ }
      return result;
    } catch (error) {
      return { status: 'failed', message: error instanceof Error && /^(Olist|Rate)/.test(error.message) ? error.message : 'Falha na execução' };
    }
  }

  async sendAndVerify(method: 'POST' | 'PUT' | 'DELETE', path: string, body: unknown, reached: () => Promise<boolean>) {
    let response: unknown;
    try { response = await this.d.writer.send(method, path, body); }
    catch (error) {
      if (!(error instanceof OlistWriteUnknown)) throw error;
      const ok = await reached().catch(() => false);
      return ok ? { status: 'succeeded' as const, verified: true, message: 'Resposta perdida; resultado confirmado por leitura' } : { status: 'unknown' as const, message: error.message };
    }
    const verified = await reached().catch(() => false);
    return { status: 'succeeded' as const, verified, response, message: verified ? undefined : 'Enviado; leitura imediata ainda não reflete o valor (verifique novamente)' };
  }
}

// Maps a GET /produtos/{id} response to the PUT request model (docs/olist-openapi.json: AtualizarProdutoRequestModel).
// Response-only fields (id, situacao, tipo, variacoes, anexos, custos, tags…) are not part of the request model and are left out.
export function productPutBody(raw: Record<string, unknown>) {
  const o = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  const ref = (v: unknown) => { const id = o(v).id; return typeof id === 'number' ? { id } : undefined; };
  const d = o(raw.dimensoes), e = o(raw.estoque), p = o(raw.precos), seo = o(raw.seo), t = o(raw.tributacao);
  const body: Record<string, unknown> = {
    sku: raw.sku, descricao: raw.descricao, descricaoComplementar: raw.descricaoComplementar, unidade: raw.unidade, unidadePorCaixa: raw.unidadePorCaixa,
    ncm: raw.ncm, gtin: raw.gtin, origem: raw.origem === undefined || raw.origem === null || raw.origem === '' ? undefined : Number(raw.origem),
    codigoEspecificadorSubstituicaoTributaria: raw.codigoEspecificadorSubstituicaoTributaria, garantia: raw.garantia, observacoes: raw.observacoes,
    marca: ref(raw.marca), categoria: ref(raw.categoria),
    precos: { preco: p.preco, precoPromocional: p.precoPromocional, precoCusto: p.precoCusto },
    dimensoes: { embalagem: o(d.embalagem).tipo !== undefined ? { id: o(d.embalagem).id, tipo: o(d.embalagem).tipo } : undefined, largura: d.largura, altura: d.altura,
      comprimento: d.comprimento, diametro: d.diametro, pesoLiquido: d.pesoLiquido, pesoBruto: d.pesoBruto },
    tributacao: Object.keys(t).length ? t : undefined,
    seo: Object.keys(seo).length ? { titulo: seo.titulo, descricao: seo.descricao, keywords: seo.keywords, linkVideo: seo.linkVideo, slug: seo.slug } : undefined,
    fornecedores: Array.isArray(raw.fornecedores) ? raw.fornecedores : undefined,
    estoque: Object.keys(e).length ? { controlar: e.controlar, sobEncomenda: e.sobEncomenda, minimo: e.minimo, maximo: e.maximo, diasPreparacao: e.diasPreparacao, localizacao: e.localizacao } : undefined
  };
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}
// PUT /produtos/{id}/variacoes/{idVariacao} (AtualizarProdutoVariacaoRequestModel = ProdutoModel): no descricao, and estoque
// is left out so the variation's stock settings are not resent through this endpoint.
export function variationPutBody(raw: Record<string, unknown>) {
  const { descricao: _d, estoque: _e, ...body } = productPutBody(raw);
  return body;
}
const watched = ['sku', 'descricao', 'descricaoComplementar', 'ncm', 'gtin', 'marca', 'categoria', 'precos', 'dimensoes', 'variacoes', 'anexos'];
export function preservedDrift(before: Record<string, unknown>, after: Record<string, unknown>, changed: string[]) {
  const norm = (k: string, v: unknown) => k === 'variacoes' || k === 'anexos' ? (Array.isArray(v) ? v.length : 0)
    : k === 'marca' || k === 'categoria' ? (v as { id?: number } | null)?.id ?? null
    : k === 'precos' ? (v as { preco?: number } | null)?.preco ?? null
    : k === 'dimensoes' ? JSON.stringify([(v as Record<string, unknown> | null)?.pesoBruto, (v as Record<string, unknown> | null)?.largura]) : v ?? null;
  return watched.filter(k => !changed.includes(k) && JSON.stringify(norm(k, before[k])) !== JSON.stringify(norm(k, after[k])));
}

async function insertItems(client: { query: Pool['query'] }, id: string, items: ItemPlan[]) {
  for (const [seq, i] of items.entries())
    await client.query(`INSERT INTO change_items(proposal_id,seq,operation,target,before,after,status,message) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, seq, i.operation, i.target, i.before, i.after, i.status, i.message ?? null]);
}

function nextStep(status: string, config: Config) {
  if (status === 'pending') return config.APPROVAL_MODE === 'admin'
    ? `Aguardando aprovação humana em ${config.PUBLIC_URL}/admin (Bearer administrativo). O agente não consegue aprovar.`
    : 'Peça confirmação explícita ao usuário e chame change_confirm com o codigoConfirmacao.';
  return ({ preparing: 'Validando linhas em segundo plano; consulte com change_get.', executing: 'Executando; consulte com change_get.',
    blocked: 'Bloqueada por segurança; veja blocked_reason e riscos.', expired: 'Expirada; prepare novamente.' } as Record<string, string>)[status] ?? null;
}
