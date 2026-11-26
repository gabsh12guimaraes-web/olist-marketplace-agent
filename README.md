# olist-marketplace-agent

Projeto privado (`private: true`, `UNLICENSED`) em TypeScript e Node.js 24, com SDK MCP oficial `@modelcontextprotocol/sdk` v1, Express e PostgreSQL. Transporte **Streamable HTTP stateless** em `/mcp`, com Bearer token próprio. Cada instância configurada representa **uma conta Olist**. Não há credenciais reais neste projeto nem repositório remoto criado automaticamente.

A integração lê catálogo, SKUs, variações, preços e estoques do Olist ERP API V3. Leituras usam uma allowlist de rotas GET. **Desde a v0.2.0** existem propostas de alteração de estoque, preço, produto e SKU, lotes CSV/XLSX, vínculos de anúncios, diagnósticos e automações de relatório — com **escrita real desativada por padrão** (`WRITE_MODE=disabled`), aprovação humana no painel `/admin` validada pelo servidor e allowlist de quatro rotas de escrita documentadas (sem DELETE). Status completo, ferramentas, permissões e próximos passos: **[docs/entrega.md](docs/entrega.md)**.

Contratos, diferenças de schemas e fontes estão em [docs/sources.md](docs/sources.md); o OpenAPI oficial foi consultado em 30/10/2026 e está versionado para revisão. Este projeto não foi autenticado contra uma conta real. A integração de produção depende de aplicativo privado e permissões concedidas no ERP.

## Desenvolvimento local

### Atalho Windows para este ambiente

Os scripts em `scripts/` usam Node do PATH ou o runtime local do Codex, quando disponível. Eles não imprimem credenciais. No PowerShell, dentro desta pasta:

```powershell
.\scripts\local.ps1 -Action Prepare
.\scripts\local.ps1 -Action Check
.\scripts\local.ps1 -Action Migrate
.\scripts\local.ps1 -Action Start
```

`Prepare` cria `.env` uma única vez, gera os dois Bearer tokens e a chave AES, e preserva arquivos já existentes. Preencha `DATABASE_URL`, `OLIST_CLIENT_ID` e `OLIST_CLIENT_SECRET` no editor local. O banco deve existir antes de `Migrate`. Se PostgreSQL/Docker estiverem ausentes, instale um deles ou informe a conexão de um PostgreSQL de desenvolvimento disponível. `Start` mantém o servidor no terminal; Ctrl+C encerra o processo.

Antes de abrir OAuth, copie apenas a URL cadastrada na Olist e execute a comparação literal:

```powershell
.\scripts\local.ps1 -Action Check -RegisteredCallback 'http://localhost:3000/oauth/olist/callback'
```

O argumento deve ser o endereço efetivamente copiado da tela Olist. O script compara esse valor com `.env`; não acessa nem verifica a tela remotamente. A URL local prevista é `http://localhost:3000/oauth/olist/callback`. Não prossiga se houver divergência, inclusive barra final, protocolo, porta ou hostname. Esses comandos não abrem OAuth nem fazem chamadas à Olist.

Requisitos: Node.js 24+, pnpm 11.25.0 e PostgreSQL 17 (ou Docker Compose). Instale pnpm com `npm install --global pnpm@11.25.0` se necessário.

```powershell
cd olist-marketplace-agent
pnpm install --frozen-lockfile
Copy-Item .env.example .env
```

Preencha `.env` localmente. Para cada um de `MCP_BEARER_TOKEN`, `ADMIN_BEARER_TOKEN` e `TOKEN_ENCRYPTION_KEY`, gere um valor diferente:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`TOKEN_ENCRYPTION_KEY` exige 64 dígitos hexadecimais. Os dois Bearer tokens exigem ao menos 32 caracteres e precisam ser diferentes. Use um gerenciador de segredos para produção. Não envie esses valores ao chat, não os coloque no README, no Git ou em argumentos de URL. `.env` e chaves privadas estão ignorados pelo Git e pela imagem Docker.

Configure `OLIST_CLIENT_ID`, `OLIST_CLIENT_SECRET`, `OLIST_ACCOUNT_ID`, `PUBLIC_URL` e `OLIST_REDIRECT_URI`. O identificador da conta é um namespace interno estável escolhido por você; ele **não é enviado como parâmetro inventado à API**. Não reutilize esse namespace ao trocar de seller. Para múltiplas contas, use credenciais/Bearer separados e instâncias isoladas; este servidor não oferece cadastro multiusuário ou seleção de seller pelo MCP.

Para iniciar o banco local:

```powershell
$env:POSTGRES_PASSWORD = Read-Host 'Senha do banco local'
docker compose up -d --wait postgres
```

Use a mesma senha em `DATABASE_URL`, escapada para URL se necessário. `POSTGRES_PASSWORD` pode também ser configurada no `.env` local para o Compose. O PostgreSQL só publica a porta em loopback. Para um banco já disponível, basta configurar `DATABASE_URL`.

```powershell
pnpm migrate
pnpm check
pnpm test
pnpm dev
```

`GET http://localhost:3000/healthz` confirma que o processo responde. `/readyz` exige o Bearer administrativo e consulta o banco. A inicialização do servidor exige schema aplicado, mesmo antes de autorizar a Olist.

## Aplicativo privado e callback OAuth

1. Na conta Olist, configure um aplicativo privado em Configurações → Geral → Aplicativos, seguindo a [documentação oficial](https://api-docs.erp.olist.com/documentacao/comecando/criando-um-aplicativo).
2. Autorize somente **Leitura** nos módulos Produtos, Estoque e Listas de Preço necessários. Não marque inclusão, edição ou exclusão. As permissões do usuário no ERP também se aplicam.
3. Cadastre exatamente a URL configurada em `OLIST_REDIRECT_URI`: no desenvolvimento, `http://localhost:3000/oauth/olist/callback`; em produção, `https://seu-host/oauth/olist/callback`. Use o mesmo host durante todo o fluxo: `localhost` e `127.0.0.1` não são intercambiáveis para cookies.
4. Copie client ID e secret para o secret manager ou `.env` local e inicie o serviço.
5. Abra `http://localhost:3000/oauth/olist/connect` no navegador. Informe a URL copiada do cadastro do aplicativo Olist e o `ADMIN_BEARER_TOKEN` do `.env` local. Clique em **Autorizar na Olist**. A página compara o callback literalmente antes de criar state e cookie; não salva o Bearer no navegador. Como alternativa, no console de desenvolvedor da mesma origem, execute:

```javascript
const admin = prompt('Bearer administrativo (não será persistido)');
const response = await fetch('/oauth/olist/start', {
  method: 'POST',
  headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ registered_redirect_uri: prompt('Cole a URL cadastrada na Olist') }),
  credentials: 'same-origin'
});
if (!response.ok) throw new Error('Não foi possível iniciar OAuth');
location.assign((await response.json()).authorization_url);
```

Conceda acesso na Olist. O callback confere o state aleatório, a expiração de dez minutos e um cookie HttpOnly/SameSite=Lax vinculado ao navegador. Ele consome o state atomicamente e salva apenas tokens criptografados com AES-256-GCM, vinculados à conta por AAD. Não execute o início com curl e depois abra apenas a URL em outro navegador: o vínculo por cookie é obrigatório. Em produção use a origem HTTPS real no passo 5.

Depois da mensagem de sucesso do callback, execute `.\scripts\local.ps1 -Action VerifyConnection`. Esse comando verifica HTTP, banco, presença de autorização e faz uma consulta MCP de uma página com um produto, sem exibir credenciais ou dados de catálogo. Sem autorização, informa a pendência e não chama a API Olist. A URL completa de autorização contém Client ID e state e só é gerada ao enviar o formulário; não deve ser copiada para logs ou chat.

`client_secret` fica no ambiente/secret manager; tokens ficam criptografados no banco. Refresh é coordenado por advisory lock PostgreSQL entre réplicas e persiste o refresh token rotacionado. Renovação expirada/revogada exige repetir a autorização. Falha após consumir um código também exige reiniciar o fluxo; não repetimos automaticamente códigos OAuth. Não há endpoint de exposição de tokens.

## Ferramentas MCP

São 42 ferramentas; a lista completa e os contratos estão em [docs/entrega.md](docs/entrega.md#2-ferramentas-mcp-42). As 11 originais abaixo seguem inalteradas e declaram `readOnlyHint: true`, `destructiveHint: false`. Inputs desconhecidos são rejeitados. IDs são inteiros positivos seguros em JavaScript. Os schemas validam projeções dos dados oficiais e descartam campos não usados.

| Ferramenta | Entrada principal | Resultado |
| --- | --- | --- |
| `olist_list_products` | `limit`, `offset`, `nome?`, `codigo?`, `situacao?`, `idListaPreco?` | Página de produtos |
| `olist_get_product` | `idProduto` | Detalhes do produto |
| `olist_list_skus` | Mesmos filtros de produtos | IDs, SKUs, descrição e tipo de variação |
| `olist_find_sku` | `sku`, `limit`, `offset` | Candidatos e correspondências exatas da página |
| `olist_list_variations` | `idProduto` | Variações embutidas no produto |
| `olist_get_variation` | `idProduto`, `idVariacao` | Variação localizada no pai |
| `olist_get_prices` | `idProduto`, `idVariacao?` | Preços retornados pelo ERP |
| `olist_list_stock` | `limit`, `offset`, `dataAlteracao?` | Página de estoques |
| `olist_get_stock` | `idProduto` | Saldo, reserva, disponível e depósitos |
| `olist_list_price_lists` | `limit`, `offset`, `nome?` | Tabelas de preço |
| `olist_get_price_list` | `idListaDePreco`, `idProduto?` | Tabela e exceção conforme contrato |

Paginação padrão 50, limite local 100. SKU não é presumido único: use IDs e considere todas as páginas. Para estoque de uma variação use o ID Olist correspondente, sem transformar SKU em ID. Preço de venda de marketplace, comissão, frete e regras comerciais não são calculados. Ausência de dados de preço/variação retorna `null`, sem afirmar que o valor é zero ou que não existem variações.

## Codex

Consulte a [documentação oficial OpenAI para MCP](https://developers.openai.com/codex/mcp). Disponibilize `OLIST_MCP_TOKEN` no ambiente do processo que inicia o Codex, com **o mesmo valor** de `MCP_BEARER_TOKEN` do servidor. `OLIST_MCP_TOKEN` é o nome da variável do cliente; não é o access token OAuth da Olist. Reinicie o Codex se a variável foi definida após a abertura do aplicativo.

```powershell
codex mcp add olist --url http://localhost:3000/mcp --bearer-token-env-var OLIST_MCP_TOKEN
codex mcp list
```

Alternativamente, em `~/.codex/config.toml`:

```toml
[mcp_servers.olist]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "OLIST_MCP_TOKEN"
```

Para deploy substitua a URL por `https://seu-host/mcp`. Autenticação deste MCP é Bearer pré-configurado, de um único principal por instalação; **não** é um servidor de autorização OAuth MCP com discovery/login. OAuth Olist acontece separadamente no callback do serviço. O token administrativo nunca é configurado no Codex.

## Deploy privado

```powershell
docker build -t olist-marketplace-agent .
```

Provisione PostgreSQL, aplique `db/*.sql` em ordem numa transação ou execute `node dist/migrate.js` usando a imagem com `DATABASE_URL` injetada. Inicie a imagem com as variáveis validadas em `.env.example` fornecidas pelo secret manager. Ela roda como usuário `node`; não inclui `.env`, credenciais ou testes. `HOST=0.0.0.0` é necessário no contêiner. `PUBLIC_URL` continua sendo a origem HTTPS pública/privada de acesso do cliente.

Coloque atrás de proxy TLS em rede privada ou com acesso restrito. Preserve o header **Host** público exato, o header Authorization e os headers MCP; configure timeout de upstream de ao menos 60 segundos. Configure o proxy para não registrar query string do callback, cookies, Authorization nem corpos de resposta. O serviço não confia em `X-Forwarded-Host` e recusa Host/Origin divergentes; clientes MCP sem Origin são aceitos com Bearer válido. Não habilitamos CORS amplo. GET/DELETE em `/mcp` retornam 405 porque o transporte não mantém sessões nem SSE persistente.

Use TLS verificado ao conectar ao PostgreSQL remoto (`sslmode=verify-full` e CA adequada); não desative validação de certificado. Restrinja a role da aplicação às tabelas necessárias; a role que aplica migrações pode ser separada. Backup criptografado, restauração testada e cópia segura da chave AES são necessários. Para rotacionar a chave AES, pare as instâncias, reautorize a conta sob a nova chave (ou implemente uma migração controlada de recriptografia) e só então retome. Perder a chave exige nova autorização. Rotate os Bearer tokens no servidor e cliente em conjunto.

`OLIST_READ_RPM` deve caber no plano e reservar cota para outras integrações. A coordenação PostgreSQL cobre réplicas deste projeto usando o mesmo `OLIST_ACCOUNT_ID`; não controla o consumo de aplicativos externos. Headers do ERP acionam cooldown compartilhado. Há timeout por requisição, orçamento de retry e tamanho máximo de resposta (2 MB). Ajuste o limite de página se o conteúdo for grande.

## Auditoria, logs e testes

Logs JSON com Pino contêm eventos, request ID, ferramenta, duração e classificação segura de erro; não incluem parâmetros, URLs de callback, tokens ou payloads do catálogo. O `request_id` também aparece no header HTTP e em falhas MCP. Cada execução válida começa um registro em `audit_events` **antes** da leitura externa; falha ao gravar auditoria impede retornar sucesso. Queda do processo pode deixar `outcome=started`, que sinaliza execução incompleta. Requisições não autenticadas e argumentos inválidos não executam ferramentas nem são persistidos como chamadas comerciais.

`id_mappings` preserva UUID interno por conta/provedor/tipo/ID externo e atualiza SKU observado; UUIDs não são prometidos como IDs de outros marketplaces. A resolução de SKU usa dados atuais do ERP, não um cache presumido completo. Defina retenção e limpeza agendada de auditoria conforme sua política; tokens não devem entrar em dumps sem controle de acesso.

```powershell
pnpm check
pnpm build
pnpm test
# Banco de testes separado, nunca uma base de produção:
$env:TEST_DATABASE_URL = 'postgresql://USUARIO:SENHA@localhost:5432/olist_test'
pnpm test
```

Sem `TEST_DATABASE_URL`, o teste PostgreSQL é explicitamente pulado. Com essa variável, ele valida schema, state, replay/expiração, persistência criptografada, refresh concorrente, rollback, mapeamento e cooldown. A CI inclui PostgreSQL 17 e executa esse teste, além da suíte HTTP/MCP. Os testes HTTP usam uma porta loopback efêmera. Nenhum teste chama a Olist real ou exige credenciais reais.

O workflow em `.github/workflows/ci.yml` pressupõe que **esta pasta** seja a raiz do repositório. Para hospedagem, crie um repositório com visibilidade **Private** e envie esta pasta como raiz; `private: true` impede publicação npm acidental, mas não altera visibilidade de GitHub. Nenhum repositório público ou remoto foi criado por este projeto.

## Escrita, aprovação e marketplaces

Fluxo: `change_prepare_*`/`batch_import` → prévia com antes/depois → aprovação humana em `/admin` (Bearer administrativo) → execução com checagem de concorrência e verificação por releitura → `change_get`/`verify_sync`. O agente não consegue aprovar no modo `admin`. Para habilitar escrita siga [docs/entrega.md §14](docs/entrega.md#14-próximos-passos-para-habilitar-escrita-em-produção).

`src/adapters/marketplaces.ts` registra Shopee, Mercado Livre, SHEIN, Nuvemshop e TikTok Shop com bloqueios e documentação oficial; nenhum anuncia capacidades enquanto não for autenticado e validado contra a API real.
