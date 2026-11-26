import { setTimeout as sleep } from 'node:timers/promises';
import type { ReadLimiter } from '../rate-limit.ts';
import type { ReadAdapter, WriteAdapter, WriteMethod } from './contracts.ts';
export const API_BASE = 'https://api.tiny.com.br/public-api/v3';
const n = '[1-9]\\d*';
const route = (path: string) => new RegExp(`^${path.replaceAll('{id}', n)}$`);
export const allowedPaths = ['/produtos', '/produtos/{id}', '/estoque', '/estoque/{id}', '/listas-precos', '/listas-precos/{id}',
  '/depositos', '/categorias/todas', '/marcas', '/intermediadores', '/intermediadores/{id}', '/estoque/{id}/logs-movimentacao',
  '/produtos/{id}/logs-alteracao', '/produtos/{id}/custos', '/produtos/{id}/anexos', '/pedidos', '/pedidos/{id}', '/info'].map(route);
// Writes are limited to the dedicated, documented endpoints. No DELETE, no bulk endpoints, no order/fiscal writes.
export const allowedWrites: readonly { method: WriteMethod; path: RegExp }[] = [
  { method: 'POST', path: route('/estoque/{id}') },
  { method: 'PUT', path: route('/produtos/{id}/preco') },
  { method: 'PUT', path: route('/produtos/{id}/variacoes/{id}/preco') },
  { method: 'PUT', path: route('/produtos/{id}') },
  { method: 'PUT', path: route('/produtos/{id}/variacoes/{id}') },
  { method: 'POST', path: route('/produtos') },
  { method: 'POST', path: route('/produtos/{id}/variacoes') },
  // Additive only (POST appends). The PUT variant replaces all attachments and is deliberately not allowed.
  { method: 'POST', path: route('/produtos/{id}/anexos') },
  // Single-record deletions only (product or one variation); never orders, fiscal documents or attachments in bulk.
  { method: 'DELETE', path: route('/produtos/{id}') },
  { method: 'DELETE', path: route('/produtos/{id}/variacoes/{id}') }
];
export class OlistHttpError extends Error {
  readonly status: number;
  constructor(status: number) { super(`Olist HTTP ${status}${status === 429 ? '; retry later' : ''}`); this.status = status; }
}
// Thrown when a write may or may not have been applied upstream; callers must verify by reading.
export class OlistWriteUnknown extends Error {}
export interface TokenProvider { accessToken(invalidToken?: string): Promise<string> }
export class OlistAdapter implements ReadAdapter, WriteAdapter {
  readonly auth: TokenProvider; readonly limiter: ReadLimiter; readonly request: typeof fetch;
  constructor(auth: TokenProvider, limiter: ReadLimiter, request = fetch) { this.auth = auth; this.limiter = limiter; this.request = request; }
  async get(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    if (!allowedPaths.some(p => p.test(path))) throw new Error('Read endpoint not allowed');
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    let token = await this.auth.accessToken();
    let renewed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.limiter.acquire();
      let res: Response;
      try { res = await this.request(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }); }
      catch { throw new Error('Olist unavailable or timed out'); }
      await this.limiter.observe(res.headers, res.status);
      if (res.status === 401 && !renewed && attempt < 2) {
        await res.body?.cancel(); token = await this.auth.accessToken(token); renewed = true; continue;
      }
      if ([502, 503, 504].includes(res.status) && attempt < 2) { await res.body?.cancel(); await sleep(250 * 2 ** attempt + Math.random() * 100); continue; }
      if (!res.ok) { await res.body?.cancel(); throw new OlistHttpError(res.status); }
      return readJson(res);
    }
    throw new Error('Olist retry budget exhausted');
  }
  // Only 401 is retried: the request was rejected before processing. Any other failure after sending is
  // reported as unknown outcome; no automatic resend that could duplicate a stock movement.
  async send(method: WriteMethod, path: string, body: unknown): Promise<unknown> {
    if (!allowedWrites.some(w => w.method === method && w.path.test(path))) throw new Error('Write endpoint not allowed');
    const url = new URL(`${API_BASE}${path}`);
    let token = await this.auth.accessToken();
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.limiter.acquire();
      let res: Response;
      const hasBody = body !== undefined;
      try { res = await this.request(url, { method, redirect: 'error', signal: AbortSignal.timeout(15000), body: hasBody ? JSON.stringify(body) : undefined,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(hasBody ? { 'Content-Type': 'application/json' } : {}) } }); }
      catch { throw new OlistWriteUnknown('Olist write timed out or connection lost; verify before retrying'); }
      await this.limiter.observe(res.headers, res.status);
      if (res.status === 401 && attempt === 0) { await res.body?.cancel(); token = await this.auth.accessToken(token); continue; }
      if (res.status >= 500) { await res.body?.cancel(); throw new OlistWriteUnknown(`Olist HTTP ${res.status} on write; verify before retrying`); }
      if (!res.ok) { await res.body?.cancel(); throw new OlistHttpError(res.status); }
      if (res.status === 204 || !res.body) return null;
      return readJson(res).catch(() => null);
    }
    throw new OlistHttpError(401);
  }
}
async function readJson(res: Response): Promise<unknown> {
  // Bound remote content to protect memory and MCP context. Never log response bodies.
  const chunks: Uint8Array[] = []; let size = 0;
  if (!res.body) throw new Error('Empty Olist response');
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > 2_000_000) { throw new Error('Olist response too large; reduce limit'); }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid Olist JSON'); }
}
