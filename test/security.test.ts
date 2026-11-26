import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, seal, unseal, nonce } from '../src/security.ts';
import { loadConfig } from '../src/config.ts';
import { retryDelay } from '../src/rate-limit.ts';
import { config } from './fixture.ts';
test('bearer authentication rejects absent, wrong and empty credentials', () => {
  assert.equal(authorized(undefined, config.MCP_BEARER_TOKEN), false);
  assert.equal(authorized('Bearer ', config.MCP_BEARER_TOKEN), false);
  assert.equal(authorized(`Bearer ${config.ADMIN_BEARER_TOKEN}`, config.MCP_BEARER_TOKEN), false);
  assert.equal(authorized(`Bearer ${config.MCP_BEARER_TOKEN}`, config.MCP_BEARER_TOKEN), true);
});
test('AES-GCM binds tokens to account and detects tampering and key changes', () => {
  const value = { access_token: nonce(), refresh_token: nonce() };
  const encrypted = seal(value, config.TOKEN_ENCRYPTION_KEY, 'seller-1');
  assert.deepEqual(unseal(encrypted, config.TOKEN_ENCRYPTION_KEY, 'seller-1'), value);
  assert.ok(!encrypted.includes(value.access_token));
  assert.throws(() => unseal(encrypted, config.TOKEN_ENCRYPTION_KEY, 'seller-2'));
  assert.throws(() => unseal(encrypted, 'cd'.repeat(32), 'seller-1'));
  const parts = encrypted.split('.'); parts[2] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => unseal(parts.join('.'), config.TOKEN_ENCRYPTION_KEY, 'seller-1'));
});
test('config error contains field name but no secret input', () => {
  assert.throws(() => loadConfig({ ...config, MCP_BEARER_TOKEN: 'sensitive' } as unknown as NodeJS.ProcessEnv), e => e instanceof Error && e.message.includes('MCP_BEARER_TOKEN') && !e.message.includes('sensitive'));
  assert.throws(() => loadConfig({ ...config, NODE_ENV: 'production' } as unknown as NodeJS.ProcessEnv));
});
test('rate limit interprets Olist reset as seconds and Retry-After date', () => {
  assert.equal(retryDelay(new Headers({ 'X-RateLimit-Reset': '05' })), 5000);
  assert.equal(retryDelay(new Headers({ 'Retry-After': '8', 'X-RateLimit-Reset': '2' })), 8000);
  assert.equal(retryDelay(new Headers({ 'Retry-After': 'Thu, 01 Jan 2026 00:00:10 GMT' }), Date.parse('2026-01-01T00:00:00Z')), 10000);
});
