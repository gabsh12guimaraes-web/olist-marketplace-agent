import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createPool, transaction, remember } from '../src/db.ts';
import { OAuth } from '../src/oauth.ts';
import { PgReadLimiter } from '../src/rate-limit.ts';
import { config } from './fixture.ts';
test('PostgreSQL: state binding/replay, encrypted persistence, concurrent refresh, mapping isolation, rate cooldown and rollback', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const pool = createPool(process.env.TEST_DATABASE_URL!);
  const account = `test-${randomUUID()}`;
  const c = { ...config, OLIST_ACCOUNT_ID: account };
  let exchanges = 0;
  const oauth = new OAuth(pool, c, async (_url, init) => {
    exchanges++;
    assert.equal(init?.method, 'POST');
    return Response.json({ access_token: `access-${exchanges}`, refresh_token: `refresh-${exchanges}`, expires_in: 3600, token_type: 'Bearer' });
  });
  try {
    await pool.query(await readFile(new URL('../db/001_init.sql', import.meta.url), 'utf8'));
    const first = await oauth.start(); const state = new URL(first.url).searchParams.get('state')!;
    await assert.rejects(oauth.callback('code', state, 'wrong-binding')); assert.equal(exchanges, 0);
    await oauth.callback('code', state, first.binding);
    await assert.rejects(oauth.callback('code', state, first.binding)); assert.equal(exchanges, 1);
    const stored = await pool.query('SELECT encrypted_payload FROM oauth_tokens WHERE account_id=$1', [account]);
    assert.ok(!stored.rows[0].encrypted_payload.includes('access-1'));
    assert.equal(await oauth.accessToken(), 'access-1');
    const rotated = await Promise.all([oauth.accessToken('access-1'), oauth.accessToken('access-1')]);
    assert.deepEqual(rotated, ['access-2', 'access-2']); assert.equal(exchanges, 2);
    const expired = await oauth.start(); const expiredState = new URL(expired.url).searchParams.get('state')!;
    await pool.query('UPDATE oauth_states SET expires_at=now()-interval \'1 second\' WHERE account_id=$1', [account]);
    await assert.rejects(oauth.callback('code', expiredState, expired.binding));
    await remember(pool, account, [{ id: 1, sku: 'A' }]); await remember(pool, account, [{ id: 1, sku: 'B' }]);
    const mapping = await pool.query('SELECT sku FROM id_mappings WHERE account_id=$1', [account]); assert.deepEqual(mapping.rows, [{ sku: 'B' }]);
    await assert.rejects(transaction(pool, async db => { await db.query('DELETE FROM id_mappings WHERE account_id=$1', [account]); throw new Error('rollback'); }));
    assert.equal((await pool.query('SELECT 1 FROM id_mappings WHERE account_id=$1', [account])).rowCount, 1);
    const limiter = new PgReadLimiter(pool, account, 30); await limiter.acquire();
    await limiter.observe(new Headers({ 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '30' }), 200);
    await assert.rejects(limiter.acquire(), /Rate limited/);
  } finally {
    for (const table of ['oauth_tokens','oauth_states','rate_slots','id_mappings','audit_events']) await pool.query(`DELETE FROM ${table} WHERE account_id=$1`, [account]);
    await pool.end();
  }
});
