// Diagnostic GET confirmed in the official OpenAPI. Not an advertised MCP capability.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
import { OAuth } from '../src/oauth.ts';
import { PgReadLimiter } from '../src/rate-limit.ts';
const report = { endpoint: 'GET /intermediadores', channels: [], responses: [], complete: false,
  limitation: 'Intermediadores/canais cadastrados nao comprovam vinculos de anuncios, produtos ou conexoes OAuth com marketplaces.' };
let pool;
try {
  const c = loadConfig(parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')));
  const spec = JSON.parse(await readFile(new URL('../docs/olist-openapi.json', import.meta.url), 'utf8'));
  if (!spec.paths['/intermediadores']?.get) throw new Error();
  pool = createPool(c.DATABASE_URL);
  const oauth = new OAuth(pool, c);
  const limiter = new PgReadLimiter(pool, c.OLIST_ACCOUNT_ID, c.OLIST_READ_RPM);
  for (let offset = 0; offset < 300; offset += 100) {
    await limiter.acquire();
    const token = await oauth.accessToken();
    const res = await fetch(`https://api.tiny.com.br/public-api/v3/intermediadores?limit=100&offset=${offset}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    });
    await limiter.observe(res.headers, res.status);
    if (!res.ok) {
      const body = await res.text();
      report.responses.push({ status: res.status, permissionIndicated: /permiss|permission|acesso negado/i.test(body),
        category: res.status === 403 ? 'PERMISSION' : res.status === 401 ? 'AUTHENTICATION_OR_MODULE_PERMISSION' : res.status === 429 ? 'RATE_LIMIT' : res.status === 400 ? 'PARAMETER_OR_VALIDATION' : 'API_ERROR' });
      break;
    }
    const data = await res.json();
    if (!Array.isArray(data.itens)) throw new Error();
    report.responses.push({ status: res.status, items: data.itens.length });
    report.channels.push(...data.itens.map(i => ({ id: i.id, nome: i.nome, canalVenda: i.canalVenda })));
    if (data.itens.length < 100 || offset + data.itens.length >= data.paginacao?.total) { report.complete = true; break; }
  }
} catch { report.error = 'DIAGNOSTIC_FAILED'; process.exitCode = 1; }
finally {
  await pool?.end();
  await mkdir(new URL('../.local/', import.meta.url), { recursive: true });
  await writeFile(new URL('../.local/marketplace-channels.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
