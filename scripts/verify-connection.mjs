import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.ts';
import { createPool } from '../src/db.ts';
let pool, client;
try {
  const c = loadConfig(parseEnv(await readFile(new URL('../.env', import.meta.url), 'utf8')));
  const health = await fetch(new URL('/healthz', c.PUBLIC_URL), { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error();
  console.log('Servidor HTTP respondendo.');
  const ready = await fetch(new URL('/readyz', c.PUBLIC_URL), { headers: { Authorization: `Bearer ${c.ADMIN_BEARER_TOKEN}` }, signal: AbortSignal.timeout(5000) });
  if (!ready.ok) throw new Error();
  console.log('Banco acessivel pelo servidor.');
  pool = createPool(c.DATABASE_URL);
  const result = await pool.query('SELECT EXISTS(SELECT 1 FROM oauth_tokens WHERE account_id=$1) AS connected', [c.OLIST_ACCOUNT_ID]);
  if (!result.rows[0].connected) {
    console.log('Autorizacao Olist pendente. Abra /oauth/olist/connect no navegador.');
    process.exitCode = 2;
  } else {
    client = new Client({ name: 'olist-local-check', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', c.PUBLIC_URL), { requestInit: { headers: { Authorization: `Bearer ${c.MCP_BEARER_TOKEN}` } } }));
    const expected = ['olist_list_products', 'olist_get_product', 'olist_list_skus', 'olist_find_sku',
      'olist_list_variations', 'olist_get_variation', 'olist_get_prices', 'olist_list_stock',
      'olist_get_stock', 'olist_list_price_lists', 'olist_get_price_list'];
    const available = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      available.push(...page.tools); cursor = page.nextCursor;
    } while (cursor);
    if (available.length !== expected.length || expected.some(name => !available.some(tool => tool.name === name && tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false))) throw new Error();
    console.log('11 ferramentas MCP disponiveis, todas declaradas somente leitura.');
    const read = await client.callTool({ name: 'olist_list_products', arguments: { limit: 1, offset: 0 } });
    if (read.isError) throw new Error();
    const data = JSON.parse(read.content.find(item => item.type === 'text').text);
    const product = data.itens?.[0];
    if (!product) {
      console.log('API autenticada respondeu, mas a listagem veio vazia; nenhum produto real pode ser confirmado.');
      process.exitCode = 2;
    } else {
      if (!Number.isSafeInteger(product.id) || product.id <= 0) throw new Error();
      const detail = await client.callTool({ name: 'olist_get_product', arguments: { idProduto: product.id } });
      if (detail.isError) throw new Error();
      const item = JSON.parse(detail.content.find(entry => entry.type === 'text').text);
      if (item.id !== product.id) throw new Error();
      console.log('OAuth ativo e API V3 acessivel: um produto real foi listado e consultado por ID via MCP.');
      console.log('Nenhum erro de autenticacao, permissao ou conexao nas chamadas executadas.');
      console.log('Nenhum dado de produto foi exibido ou alterado. Permissoes de estoque e listas de preco nao foram exercitadas por esta verificacao.');
    }
  }
} catch { console.error('Verificacao falhou. Confira o servidor e os logs sanitizados; nenhum detalhe sensivel foi exibido.'); process.exitCode = 1; }
finally { await client?.close(); await pool?.end(); }
