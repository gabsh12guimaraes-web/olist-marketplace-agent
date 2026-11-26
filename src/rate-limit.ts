import { setTimeout as sleep } from 'node:timers/promises';
import { transaction, type Pool } from './db.ts';
export interface ReadLimiter { acquire(): Promise<void>; observe(headers: Headers, status: number): Promise<void> }
export function retryDelay(headers: Headers, now = Date.now()): number {
  const raw = headers.get('retry-after');
  const retry = raw === null ? 0 : /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Math.max(0, Date.parse(raw) - now);
  // Olist documents Reset as seconds remaining, NOT a Unix timestamp.
  const reset = Number(headers.get('x-ratelimit-reset') ?? 0) * 1000;
  return Math.min(3600000, Math.max(1000, Number.isFinite(retry) ? retry : 0, Number.isFinite(reset) ? reset : 0));
}
export class PgReadLimiter implements ReadLimiter {
  readonly pool: Pool; readonly account: string; readonly rpm: number;
  constructor(pool: Pool, account: string, rpm: number) { this.pool = pool; this.account = account; this.rpm = rpm; }
  async acquire() {
    const delay = await transaction(this.pool, async db => {
      await db.query('INSERT INTO rate_slots(account_id) VALUES($1) ON CONFLICT DO NOTHING', [this.account]);
      const result = await db.query(`SELECT greatest(0,extract(epoch FROM(greatest(next_at,blocked_until)-clock_timestamp()))*1000) AS delay
        FROM rate_slots WHERE account_id=$1 FOR UPDATE`, [this.account]);
      const ms = Number(result.rows[0].delay);
      if (ms > 15000) throw new Error('Rate limited; retry later');
      await db.query(`UPDATE rate_slots SET next_at=greatest(next_at,blocked_until,clock_timestamp())+($2*interval '1 millisecond') WHERE account_id=$1`, [this.account, 60000 / this.rpm]);
      return ms;
    });
    if (delay > 0) await sleep(delay);
    // Recheck account cooldown: another in-flight response may have exhausted quota.
    const row = await this.pool.query('SELECT blocked_until>clock_timestamp() AS blocked FROM rate_slots WHERE account_id=$1', [this.account]);
    if (row.rows[0]?.blocked) throw new Error('Rate limited; retry later');
  }
  async observe(headers: Headers, status: number) {
    if (status !== 429 && headers.get('x-ratelimit-remaining') !== '0') return;
    const delay = retryDelay(headers);
    await this.pool.query(`INSERT INTO rate_slots(account_id,blocked_until) VALUES($1,clock_timestamp()+($2*interval '1 millisecond'))
      ON CONFLICT(account_id) DO UPDATE SET blocked_until=greatest(rate_slots.blocked_until,EXCLUDED.blocked_until)`, [this.account, delay]);
  }
}
