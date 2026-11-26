import { randomUUID } from 'node:crypto';
import pg from 'pg';
export const createPool = (url: string) => new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
export type Pool = pg.Pool;
export async function transaction<T>(pool: Pool, work: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query('BEGIN'); const result = await work(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
export async function remember(pool: Pool, account: string, items: { id?: number | null; sku?: string | null }[]) {
  for (const item of items) {
    if (!Number.isSafeInteger(item.id) || item.id! <= 0) continue;
    await pool.query(`INSERT INTO id_mappings(account_id,provider,entity_type,external_id,canonical_id,sku)
      VALUES($1,'olist','product',$2,$3,$4) ON CONFLICT(account_id,provider,entity_type,external_id)
      DO UPDATE SET sku=EXCLUDED.sku, observed_at=now()`, [account, String(item.id), randomUUID(), item.sku ?? null]);
  }
}
