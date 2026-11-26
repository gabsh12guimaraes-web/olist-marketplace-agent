import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
let env;
try { env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')); }
catch { console.error('.env ausente ou ilegivel. Execute a preparacao local.'); process.exit(1); }
const required = ['DATABASE_URL','OLIST_CLIENT_ID','OLIST_CLIENT_SECRET','MCP_BEARER_TOKEN','ADMIN_BEARER_TOKEN','TOKEN_ENCRYPTION_KEY'];
const missing = required.filter(name => !env[name] || env[name].includes('REPLACE_LOCAL_PASSWORD'));
if (missing.length) {
  console.log(`Preencha localmente: ${missing.join(', ')}. Nao compartilhe valores no chat.`);
  process.exit(1);
}
try { loadConfig(env); }
catch { console.error('Configuracao invalida. Confira formato das variaveis e URLs no .env; nenhum valor foi registrado.'); process.exit(1); }
if (env.PORT !== '3000' || env.PUBLIC_URL !== 'http://localhost:3000' || env.OLIST_REDIRECT_URI !== 'http://localhost:3000/oauth/olist/callback') {
  console.error('Configuracao diverge do ambiente local esperado na porta 3000. Revise antes de iniciar.'); process.exit(1);
}
console.log('Configuracao local valida. Callback: http://localhost:3000/oauth/olist/callback');
const registered = process.argv[2];
if (registered !== undefined) {
  if (registered !== env.OLIST_REDIRECT_URI) { console.error('URL cadastrada diverge do callback configurado. OAuth nao deve ser iniciado.'); process.exit(1); }
  console.log('URL informada como cadastrada coincide exatamente com OLIST_REDIRECT_URI.');
} else console.log('URL cadastrada na Olist ainda nao verificada. Nao abrir OAuth antes da comparacao.');
const pool = createPool(env.DATABASE_URL);
try {
  await pool.query('SELECT 1');
  console.log('PostgreSQL acessivel.');
  const result = await pool.query("SELECT to_regclass('public.oauth_tokens') IS NOT NULL AS migrated");
  console.log(result.rows[0].migrated ? 'Schema encontrado.' : 'Migracao pendente: execute -Action Migrate.');
} catch { console.error('PostgreSQL indisponivel ou credenciais invalidas. Confira DATABASE_URL localmente.'); process.exitCode = 1; }
finally { await pool.end(); }
