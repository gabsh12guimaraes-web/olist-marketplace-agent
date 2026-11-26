import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OAuth, AUTH_URL, TOKEN_URL } from '../src/oauth.ts';
import type { Pool } from '../src/db.ts';
import { config } from './fixture.ts';
import { digest } from '../src/security.ts';
test('OAuth sends official form fields and supports refresh rotation/fallback', async () => {
  const calls: URLSearchParams[] = [];
  const oauth = new OAuth({} as Pool, config, async (url, init) => {
    assert.equal(url, TOKEN_URL); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    const form = init!.body as URLSearchParams; calls.push(form);
    assert.equal(form.get('client_id'), config.OLIST_CLIENT_ID); assert.equal(form.get('client_secret'), config.OLIST_CLIENT_SECRET);
    return Response.json({ access_token: 'access', ...(calls.length === 1 ? { refresh_token: 'refresh' } : {}), token_type: 'Bearer', expires_in: 3600 });
  });
  const first = await oauth.exchange({ grant_type: 'authorization_code', code: 'once', redirect_uri: config.OLIST_REDIRECT_URI });
  const renewed = await oauth.exchange({ grant_type: 'refresh_token', refresh_token: first.refresh_token }, first);
  assert.equal(renewed.refresh_token, 'refresh'); assert.ok(renewed.expires_at > Date.now() + 3500000);
  assert.equal(calls[0]!.get('code'), 'once'); assert.equal(calls[1]!.get('grant_type'), 'refresh_token');
});
test('OAuth rejects failed/invalid token exchange without revealing provider payload', async () => {
  let count = 0;
  const oauth = new OAuth({} as Pool, config, async () => { count++; return new Response('private diagnostic', { status: 400 }); });
  await assert.rejects(oauth.exchange({ grant_type: 'authorization_code', code: 'once' }), e => e instanceof Error && !e.message.includes('private diagnostic'));
  assert.equal(count, 1);
  const invalid = new OAuth({} as Pool, config, async () => Response.json({ access_token: 'access', expires_in: 3600, token_type: 'Bearer' }));
  await assert.rejects(invalid.exchange({ grant_type: 'authorization_code', code: 'once' }), /Missing refresh token/);
});
test('OAuth state storage hashes random state and browser binding; callback consumes before exchange', async () => {
  const queries: { sql: string; args: unknown[] }[] = [];
  const pool = { async query(sql: string, args: unknown[] = []) { queries.push({ sql, args }); return { rowCount: 0, rows: [] }; } } as unknown as Pool;
  let requested = false;
  const oauth = new OAuth(pool, config, async () => { requested = true; return Response.json({}); });
  const started = await oauth.start(); const url = new URL(started.url); const state = url.searchParams.get('state')!;
  assert.equal(`${url.origin}${url.pathname}`, AUTH_URL); assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.get('redirect_uri'), config.OLIST_REDIRECT_URI);
  assert.equal(queries[1]!.args[0], digest(state)); assert.equal(queries[1]!.args[1], digest(started.binding));
  assert.notEqual(state, started.binding);
  await assert.rejects(oauth.callback('once', state, started.binding), /Invalid OAuth state/);
  assert.equal(requested, false); assert.ok(queries[2]!.sql.includes('DELETE FROM oauth_states'));
});
