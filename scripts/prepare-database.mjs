import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomBytes } from 'node:crypto';
const file = new URL('../.env', import.meta.url);
try {
  let source = await readFile(file, 'utf8');
  const env = parseEnv(source);
  if (env.DATABASE_URL && !env.DATABASE_URL.includes('REPLACE_LOCAL_PASSWORD')) {
    console.log('DATABASE_URL existente preservada; nenhuma senha alterada.');
    process.exit(0);
  }
  const password = env.POSTGRES_PASSWORD || randomBytes(32).toString('hex');
  function set(name, value) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, 'm');
    source = pattern.test(source) ? source.replace(pattern, () => line) : `${source.trimEnd()}\n${line}\n`;
  }
  set('DATABASE_URL', `postgresql://olist:${encodeURIComponent(password)}@localhost:5432/olist`);
  if (!env.POSTGRES_PASSWORD) set('POSTGRES_PASSWORD', password);
  await writeFile(file, source, { mode: 0o600 });
  console.log('Conexao PostgreSQL local e senha Compose configuradas em .env; valores nao exibidos.');
} catch {
  console.error('Falha ao preparar banco local. Confira permissoes do .env.');
  process.exitCode = 1;
}
