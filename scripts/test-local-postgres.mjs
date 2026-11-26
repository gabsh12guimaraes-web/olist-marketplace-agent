import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
try {
  const env = parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8'));
  const url = new URL(env.DATABASE_URL);
  if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error();
  url.pathname = '/olist_test';
  const child = spawn(process.execPath, ['--experimental-strip-types', '--test', 'test/*.test.ts'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, TEST_DATABASE_URL: url.toString() }, stdio: 'inherit'
  });
  child.on('error', () => { console.error('Falha ao iniciar testes locais.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch { console.error('Configuracao do banco local de testes invalida.'); process.exitCode = 1; }
