import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const target = new URL('../.env', import.meta.url);
try {
  let content = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const name of ['MCP_BEARER_TOKEN', 'ADMIN_BEARER_TOKEN', 'TOKEN_ENCRYPTION_KEY']) {
    content = content.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${randomBytes(32).toString('hex')}`);
  }
  await writeFile(target, content, { flag: 'wx', mode: 0o600 });
  console.log('.env criado; chaves internas geradas sem exibir valores. Preencha DATABASE_URL, OLIST_CLIENT_ID e OLIST_CLIENT_SECRET localmente.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env existente preservado; nenhuma chave foi rotacionada.');
  else { console.error('Nao foi possivel preparar .env. Verifique permissoes locais.'); process.exitCode = 1; }
}
