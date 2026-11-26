# Entrega — Agente IA de gestão de marketplaces (v0.2.0)

Data: 30/10/2026. Esta versão amplia o projeto `olist-marketplace-agent`. A autenticação, os dados e as 11 ferramentas originais foram preservados. **Nenhum dado real foi alterado** durante o desenvolvimento: todas as escritas foram testadas contra um ERP simulado. A escrita real continua **desativada** (`WRITE_MODE=disabled`).

Legenda de status:

- **TESTADA** — implementada e testada (automatizado; quando indicado, também com leitura real na Olist).
- **AG. CREDENCIAIS** — implementada, aguardando credenciais.
- **AG. PERMISSÃO** — implementada, aguardando permissão.
- **PARCIAL** — parcialmente implementada.
- **NÃO SUPORTADA** — não suportada pela API.
- **PENDENTE** — ainda não implementada.

## 1. Módulos implementados

| Módulo | Arquivo | O que faz |
| --- | --- | --- |
| Banco e migrações | `db/002_operations.sql`, `src/migrate.ts` | Propostas, itens, vínculos de anúncios, guardas de preço, automações e tokens de marketplace. A migração é aditiva, idempotente e registrada em `schema_migrations`. |
| Escrita Olist | `src/adapters/olist.ts` | Allowlist com 4 rotas documentadas (estoque, preço, preço da variação e produto); nunca DELETE. Só repete a chamada em 401 (rejeitada antes do processamento). Timeout ou 5xx viram "resultado desconhecido" e não são reenviados. |
| Planejadores | `src/planners.ts` | Leem o estado atual e calculam antes e depois, riscos e validações (estoque, preço, produto, SKU). Não escrevem nada. |
| Propostas e execução | `src/changes.ts` | O fluxo é preparar, aprovar (humano, validado no servidor) e executar. Inclui expiração, deduplicação, transição atômica, checagem de concorrência, verificação por releitura e retomada após queda (lease + `SKIP LOCKED`). Tudo é auditado. |
| Lotes | `src/spreadsheet.ts`, `src/batch.ts` | Lê CSV e XLSX sem dependências novas e valida linha por linha em segundo plano. Toda linha recebe um resultado e um motivo. |
| Vínculos | `src/mapping.ts` | Relaciona ID Olist, variação, anúncio, variação no marketplace, loja, depósito e política, com reconciliação. O SKU não é usado como chave. |
| Diagnóstico | `src/diagnostics.ts` | Testa permissões por módulo, estoque negativo e reservado, SKUs duplicados e erros recentes, cada um com causa, evidência e correção. |
| Automações | `src/automations.ts` | 8 rotinas de relatório. Todas começam desativadas e não fazem correções. |
| Painel administrativo | `src/admin-page.ts`, rotas `/admin` | É o único lugar onde um humano aprova a execução e ativa automações. |
| Marketplaces | `src/adapters/marketplaces.ts` | Status, bloqueios e documentação de cada canal, sem anunciar capacidades não validadas. |

## 2. Ferramentas MCP (42)

Anotações: **L** = leitura (`readOnlyHint`); **P** = grava somente proposta ou vínculo local; **D** = destrutiva (`destructiveHint`, o cliente pede aprovação).

| Grupo | Ferramentas |
| --- | --- |
| Originais (11, inalteradas, L) | `olist_list_products` (agora aceita `gtin`), `olist_get_product`, `olist_list_skus`, `olist_find_sku`, `olist_list_variations`, `olist_get_variation`, `olist_get_prices`, `olist_list_stock`, `olist_get_stock`, `olist_list_price_lists`, `olist_get_price_list` |
| Consultas Olist (L) | `olist_list_deposits`, `olist_list_categories`, `olist_list_brands`, `olist_list_intermediaries`, `olist_get_stock_movements`, `olist_get_product_change_log`, `olist_list_orders` (sem dados pessoais) |
| Lojas e canais (L) | `stores_list`, `stock_overview` (físico, reservado e disponível por depósito, mais anúncios), `price_overview` (ERP e preço observado por canal) |
| Vínculos | `mapping_list` (L), `mapping_link` (P), `mapping_reconcile` (L) |
| Diagnóstico (L) | `diagnose_connections`, `diagnose_stock`, `diagnose_catalog`, `errors_recent`, `error_explain` |
| Preparar (P) | `change_prepare_stock`, `change_prepare_price`, `change_prepare_product`, `change_prepare_sku`, `change_prepare_revert`, `batch_import` |
| Confirmar e acompanhar | `change_confirm` (D), `change_get` (L), `change_cancel` (P), `change_history` (L), `verify_sync` (L) |
| Automações (L) | `automation_list`, `automation_run` |

As ferramentas de preparo e confirmação são genéricas: um único `change_confirm` serve para estoque, preço, SKU, produto e lote, o que evita duplicar ferramentas.

**Entradas e respostas.** Os schemas Zod são estritos: campos desconhecidos são rejeitados. IDs são inteiros positivos. Toda proposta retorna:

- `id`, `status`, `summary`, `risks`, `blocked_reason`
- `itens[]`, cada um com `operation`, `target`, `before`, `after`, `status` e `message`
- `totais`, `canaisAfetados` e `proximoPasso`

**Erros.** A resposta vem com `isError: true` e um texto seguro, que pode ser:

- um código do serviço (`WRITE_NOT_PERMITTED`, `HUMAN_APPROVAL_REQUIRED`, `EXPIRED`, `INVALID_STATUS`, `NOT_FOUND`, `INVALID_CONFIRMATION`);
- um status HTTP da Olist, com a causa provável e a correção;
- erro de validação, com o campo.

O corpo da resposta da API nunca é repassado. Todas as mensagens trazem `request_id`.

**Status de uma proposta:**

| Status | Significado |
| --- | --- |
| `preparing` | Lote em validação |
| `pending` | Aguarda aprovação |
| `blocked` | Bloqueada por segurança |
| `executing` | Em execução |
| `succeeded` | Concluída |
| `partial` | Concluída parcialmente |
| `failed` | Falhou |
| `expired` | Expirou |
| `cancelled` / `rejected` | Cancelada ou rejeitada |

**Status de um item:**

| Status | Significado |
| --- | --- |
| `pending` | Aguarda execução |
| `skipped` | Omitido (já no valor desejado) |
| `invalid` | Erro de validação |
| `succeeded` | Executado (com `verified`) |
| `failed` | Falhou |
| `conflict` | O dado mudou desde a prévia |
| `unknown` | Enviado sem confirmação; conferir manualmente |

## 3. Funcionalidades por marketplace

Fonte: documentação oficial lida em 30/10/2026; os links ficam em `stores_list`. Nenhum canal tem credenciais, por isso **nenhum adaptador direto é operacional**. Hoje, as alterações chegam aos canais **pela integração Olist → canal**, que é o caminho recomendado para evitar sincronização circular.

| Função | Mercado Livre | Shopee | Nuvemshop | TikTok Shop | SHEIN |
| --- | --- | --- | --- | --- | --- |
| Autenticação | AG. CREDENCIAIS (OAuth; refresh de uso único) | AG. PERMISSÃO (aprovação de parceiro BR; HMAC) | AG. CREDENCIAIS (app parceiro; token sem expiração) | AG. PERMISSÃO (revisão do app; assinatura HMAC) | AG. PERMISSÃO (qualificação + whitelist de IP) |
| Anúncios, variações, preço, estoque (leitura) | PENDENTE | PENDENTE | PENDENTE | PENDENTE | PENDENTE |
| Atualizar preço/estoque direto | PENDENTE (o ERP já sincroniza) | PENDENTE | PENDENTE | PENDENTE | PENDENTE (preço passa por revisão) |
| Anúncios rejeitados/moderação | PENDENTE (`/moderations`) | PENDENTE (`get_item_violation_info`) | NÃO SUPORTADA (sem moderação) | PENDENTE (`diagnoses`) | PENDENTE (`query-document-state`) |
| Pedidos para conciliação | PENDENTE | PENDENTE | PENDENTE | PENDENTE | PENDENTE |
| Vínculo manual anúncio ↔ Olist | TESTADA (local) | TESTADA (local) | TESTADA (local) | TESTADA (local) | TESTADA (local) |

**Por que os adaptadores diretos estão PENDENTES.** Sem credenciais, qualquer cliente ficaria sem validação. A especificação proíbe apresentar como operacional o que não foi autenticado e proíbe inventar integrações. Os endpoints oficiais já levantados estão registrados para a implementação.

## 4. Testes executados

`node scripts/test-local-postgres.mjs` rodou com PostgreSQL 17 local (banco `olist_test`, separado) e o resultado foi **33/33 aprovados, 0 pulados**. Antes desta entrega eram 15 aprovados e 1 pulado.

Cobertura:

- **OAuth e tokens:** refresh, rotação e expiração (testes originais).
- **Permissões e autorização:** escrita bloqueada por padrão, permissão por operação, o agente não consegue aprovar no modo admin, o Bearer MCP não acessa `/admin/api`, e a allowlist de rotas impede DELETE.
- **Estoque:**
  - OVERTULE1 (4 / 9 / −5): o ajuste para físico 3 é bloqueado (deixaria disponível −6); o ajuste para disponível 0 gera saldo final 9.
  - Múltiplos depósitos exigem `idDeposito`.
  - Produto pai é redirecionado para as variações.
- **Concorrência e idempotência:** conflito quando o dado muda entre prévia e execução; prévia duplicada devolve a mesma proposta; aprovação dupla é recusada; execução repetida não reenvia.
- **Falhas de API e perda de conexão:** 5xx/timeout viram "desconhecido" sem reenvio; resposta perdida é confirmada por leitura; queda após o envio só verifica, sem reenviar.
- **Expiração:** proposta expirada não pode ser aprovada.
- **Preços:** limite de variação, preço mínimo, rota de variação, reajuste percentual e reversão.
- **Lotes:** CSV com SKU duplicado, inexistente, linha repetida, linha de canal, pedido de exclusão e alvo ausente. Rate limit durante a validação mantém o lote em fila. XLSX armazenado e comprimido.
- **Auditoria:** registros de preparo e execução vinculados à proposta.
- **Diagnóstico:** classificação do 403.

**Validação real (somente GET) na conta Olist, via MCP:**

| Consulta | Resultado |
| --- | --- |
| Produtos, Estoque, Listas de preço | OK |
| Depósitos, Intermediadores, Marcas, Categorias, Pedidos, logs de estoque e de alteração | **HTTP 403** |
| `stock_overview OVERTULE1` | físico 4, reservado 9, disponível −5, com alerta |
| `diagnose_stock` (100 de 1.866 itens) | **18 produtos com disponível negativo** |
| `diagnose_catalog` (100 itens) | 0 SKUs duplicados até agora |
| Prévia OVERTULE1 para físico 3 | `blocked`, nada enviado |

A migração 002 foi aplicada ao banco local de desenvolvimento.

## 5. Integrações operacionais

Olist com leitura de produtos, SKUs, variações, estoque e listas de preço. Está autenticada e validada com dados reais.

## 6. Integrações aguardando credenciais ou autorização

| Integração | Status | O que falta |
| --- | --- | --- |
| Olist: depósitos, categorias, marcas, intermediadores, pedidos, logs | AG. PERMISSÃO | Ver §7 |
| Olist: escrita de estoque e preço | AG. PERMISSÃO | Testada com mock; falta permissão de edição no aplicativo e habilitação |
| Olist: edição de produto e SKU | PARCIAL | A prévia e a análise funcionam. A execução fica bloqueada até homologar `PUT /produtos/{id}`, porque o contrato exige o cadastro completo e campos omitidos podem ser apagados |
| Mercado Livre, Nuvemshop | AG. CREDENCIAIS | Credenciais e autorização da conta |
| Shopee, TikTok Shop, SHEIN | AG. PERMISSÃO | Aprovação comercial ou de parceiro |
| Imagens (Olist) | PENDENTE | `/produtos/{id}/anexos` existe no OpenAPI, mas ainda não foi implementado |
| Cadastro de produtos e variações | PENDENTE | `POST /produtos` e `/variacoes` existem, mas não foram implementados (risco de duplicar SKU; exige homologação) |
| Filtro de preço por categoria | NÃO SUPORTADA | `GET /produtos` não filtra por categoria. O agente deve enviar `idsProdutos` |
| Pedidos filtrados por produto/SKU | NÃO SUPORTADA | Por isso a análise de SKU recomenda conferir pedidos no ERP |

## 7. Permissões adicionais necessárias na Olist

O erro 403 de Intermediadores **não é um defeito**. O aplicativo foi criado com leitura apenas em Produtos, Estoque e Listas de Preço, como recomendava o README anterior. Todos os outros módulos retornam 403.

Em **Configurações → Geral → Aplicativos → (seu aplicativo)**, conceda:

1. **Leitura:** Depósitos, Intermediadores, Marcas, Categorias, Pedidos de venda. Os logs de produto e de estoque ficam sob Produtos e Estoque; se continuarem com 403, confira as permissões do **usuário** que autorizou.
2. **Edição (somente quando for habilitar escrita):** Estoque (lançamentos) e Produtos (preço). Não conceda exclusão.
3. Depois, **reautorize** em `/oauth/olist/connect`, porque o escopo é fixado no momento da autorização, e rode `diagnose_connections` para confirmar.

## 8. Configuração

Variáveis novas no `.env.example`, todas com padrão seguro:

| Variável | Padrão | Função |
| --- | --- | --- |
| `WRITE_MODE` | `disabled` | Liga a escrita real |
| `WRITE_OPERATIONS` | vazio | `stock`, `price`, `product`, `sku` |
| `APPROVAL_MODE` | `admin` | `client` é recusado em produção |
| `PROPOSAL_TTL_MINUTES` | 30 | Validade da proposta |
| `MAX_BATCH_ITEMS` | 200 | Linhas por lote |
| `MAX_PRICE_CHANGE_PCT` | 30 | Acima disso exige `aceitarVariacaoAlta` |
| `OLIST_PRODUCT_PUT_VERIFIED` | `false` | Libera a edição de produto e SKU |
| `AUTOMATIONS_TICK_SECONDS` | 60 | Ciclo do worker |
| `ML_*`, `NUVEMSHOP_*`, `SHOPEE_*`, `TIKTOK_*`, `SHEIN_*` | vazio | Credenciais dos canais (opcionais) |

Preço mínimo e margem mínima por produto ficam na tabela `price_guards`. Nada é presumido: a margem só é avaliada quando há custo cadastrado no ERP.

## 9. Execução local

```powershell
.\scripts\local.ps1 -Action Migrate   # aplica 001 e 002 (idempotente)
.\scripts\local.ps1 -Action Start
node scripts/test-local-postgres.mjs  # testes com banco olist_test
```

Atenção: durante esta sessão, um servidor da versão anterior (iniciado antes pelo Codex) ocupava a porta 3000. Encerre esse processo antes de iniciar a nova versão, senão o Codex continuará vendo só 11 ferramentas.

## 10. Conexão ao Codex

Nada muda: `codex mcp add olist --url http://localhost:3000/mcp --bearer-token-env-var OLIST_MCP_TOKEN`. Reinicie a sessão do Codex para recarregar a lista de ferramentas.

O Codex executa ferramentas com `destructiveHint` (como `change_confirm`) somente com aprovação, conforme a política de aprovação configurada nele. Mesmo assim, **no modo admin a execução depende do painel `/admin`**: a aprovação do cliente não basta.

## 11. Preparação para ChatGPT

- O mesmo backend serve aos dois clientes: Streamable HTTP em `/mcp`.
- O ChatGPT acessa servidores MCP **remotos via HTTPS**. Ele não alcança `localhost` e a porta 3000 **não deve** ser exposta.
- **Pendência de autenticação:** este servidor usa um Bearer estático. Conectores do ChatGPT trabalham com OAuth (ou sem autenticação), conforme a documentação da OpenAI. Antes de conectar, é preciso:
  - implementar a camada OAuth 2.1 de autorização MCP (metadata de recurso protegido e servidor de autorização), ou
  - colocar à frente um proxy de identidade compatível.
  
  Status: **PENDENTE**. Confirme o mecanismo vigente, inclusive a disponibilidade do "Secure MCP Tunnel", na documentação oficial da OpenAI para o seu tipo de conta (Plus/Pro em modo desenvolvedor, Business/Enterprise com conectores administrados). Não encontrei documentação oficial verificável sobre esse túnel nesta sessão.
- **Diferenças esperadas:**
  - O Codex local tem acesso direto ao `localhost` e usa o Bearer.
  - No ChatGPT, a disponibilidade de ferramentas de escrita depende do plano e do modo desenvolvedor.
  - Em ambos, **a aprovação de escrita permanece no `/admin`**, independente do cliente.

### 11.1 Conexão implementada: OpenAI Secure MCP Tunnel

O ChatGPT acessa o servidor local pelo [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). A conexão é só de saída: nenhuma porta fica exposta na internet e nenhum token é configurado no ChatGPT.

- **Endpoint do túnel:** `http://127.0.0.1:3001/mcp` (`TUNNEL_MCP_PORT`).
  - Aceita conexões somente de loopback e recusa `Origin` e Hosts estranhos.
  - Expõe **33 ferramentas, todas de leitura**.
  - Exige `TUNNEL_MCP_BEARER_TOKEN`, que o `tunnel-client` injeta via `--mcp.extra-headers`. Os tokens do Codex e do admin não funcionam nele.
- **Cliente:** `tunnel-client-runtime` v0.0.19 oficial (Windows amd64, SHA-256 conferido), em `%USERPROFILE%\tools\openai-tunnel-client\v0.0.19\bin`.
- **Plano ChatGPT Pro:** MCP customizado só com leitura/fetch. Alterações continuam pelo Codex e pela aprovação no `/admin`.

**Passos:**

1. Em https://platform.openai.com/settings/organization/tunnels, crie um túnel e gere a chave de runtime. São necessários os papéis Tunnels Read + Manage + Use.
2. Preencha `.secrets\chatgpt-tunnel.env` com `CONTROL_PLANE_TUNNEL_ID` e `CONTROL_PLANE_API_KEY`. O arquivo é criado por `scripts\chatgpt-tunnel.ps1 -Action Setup` e é ignorado pelo Git.
3. Execute `.\scripts\chatgpt-tunnel.ps1 -Action Start` e deixe o terminal aberto.
4. No ChatGPT, ative o Developer mode. Depois clique em **+**, escolha **Add custom MCP server**, selecione **Connection: Tunnel**, escolha o túnel e use **Authentication: None**.

### 11.2 Pedidos pelo ChatGPT, aprovação no /admin

Com `TUNNEL_TOOLSET=prepare`, o ChatGPT pode **preparar** alterações e cadastros, mas **não pode confirmar** nada. A ferramenta `change_confirm` não é exposta nesse canal. A execução acontece somente quando você aprova em **http://localhost:3000/admin**, informando o `ADMIN_BEARER_TOKEN`.

| Pedido no chat | Ferramenta | Execução |
| --- | --- | --- |
| Estoque / preço | `change_prepare_stock`, `change_prepare_price` | Liberada (`WRITE_OPERATIONS` inclui `stock,price`) |
| Cadastrar produto | `change_prepare_create_product` (simples ou com variações, preços, GTIN, NCM, dimensões, imagens por URL) | Liberada (`create`) |
| Nova variação | `change_prepare_create_variation` | Liberada (`create`) |
| Título, descrição, marca, categoria | `change_prepare_product` | Só nos produtos listados em `HOMOLOGATION_PRODUCT_IDS`, até definir `OLIST_PRODUCT_PUT_VERIFIED=true` |
| SKU | `change_prepare_sku` | Mesma regra, além de não haver vínculos nem duplicidade |
| Planilha | `batch_import` | Conforme o tipo de cada linha |
| Publicar anúncio no marketplace | — | **Não suportado pela API V3.** Publique no painel da Olist |

**Pré-requisito na Olist:** dê ao aplicativo permissão de **edição** em Produtos e Estoque e autorize de novo. Sem isso, cada execução aprovada termina com HTTP 403 e nada é alterado.

## 12. Hospedagem recomendada

| Opção | Custo | Observação |
| --- | --- | --- |
| Manter local + Codex | gratuito | Atende o uso atual |
| Cloudflare Tunnel + Cloudflare Access (ou um único VPS pequeno com Caddy e TLS) | gratuito / baixo | Expõe somente HTTPS, sem abrir porta. `PUBLIC_URL` deve ser a origem pública e `NODE_ENV=production` exige HTTPS |
| PostgreSQL gerenciado | variável | Use TLS `verify-full`, backup criptografado e cópia segura da `TOKEN_ENCRYPTION_KEY` |

Para a SHEIN é obrigatório IP de saída fixo, o que favorece o VPS.

## 13. Manual de uso (exemplos em português)

| Você pede | O agente usa |
| --- | --- |
| "Mostre o estoque do SKU X em todas as lojas." | `stock_overview { sku }` |
| "Quais produtos estão com estoque divergente?" | `diagnose_stock` (continua com `proximoOffset`) |
| "Prepare o estoque do SKU X para 20 unidades." | O agente deve perguntar se são 20 **físicas** ou 20 **disponíveis**, depois `change_prepare_stock` |
| "Atualize o preço da categoria X em 5%, com prévia." | Como a API não filtra por categoria, o agente lista os produtos, você confirma os IDs e ele usa `change_prepare_price { idsProdutos, percentual: 5 }` |
| "Localize anúncios com erro no TikTok Shop." | Hoje responde que o canal aguarda permissão (`stores_list`) |
| "Identifique SKUs duplicados." | `diagnose_catalog`, repetido página a página |
| "Compare os preços da Shopee e do Mercado Livre." | `price_overview`. Depende de vínculos com preço observado; sem adaptadores, mostra apenas o ERP |
| "Prepare a correção dos produtos desta planilha." | `batch_import`, depois `change_get` até `pending` |
| "Quais alterações foram realizadas hoje?" | `change_history { desde: "AAAA-MM-DDT00:00:00-03:00" }` |

**Fluxo de escrita:**

1. A prévia mostra antes, depois, canais afetados e riscos.
2. Você abre `http://localhost:3000/admin`, informa o token administrativo e clica em **Aprovar e executar**.
3. O agente consulta `change_get` e `verify_sync` e informa o resultado.
4. Se precisar desfazer: `change_prepare_revert`.

## 14. Próximos passos para habilitar escrita em produção

1. Encerrar o servidor antigo, aplicar a migração e reiniciar.
2. Conceder as permissões do §7 e reautorizar. Confirmar com `diagnose_connections`.
3. Escolher **um produto de teste** (nunca o OVERTULE1) e homologar:
   1. `WRITE_MODE=enabled` e `WRITE_OPERATIONS=price`.
   2. Fazer uma alteração de preço pelo fluxo completo.
   3. Conferir no ERP e no canal.
   4. Reverter.
4. Repetir a homologação para `stock`, conferindo físico, reservado e disponível e a propagação nos canais.
5. Só então decidir sobre `product` e `sku`. Homologar `PUT /produtos/{id}` em produto de teste e conferir campo a campo se algo foi apagado antes de `OLIST_PRODUCT_PUT_VERIFIED=true`.
6. Investigar os 18+ produtos com disponível negativo (reservas de pedidos), sem correção automática.
7. Solicitar credenciais dos canais (Mercado Livre e Nuvemshop primeiro, por não exigirem aprovação comercial) para implementar e validar os adaptadores de leitura de anúncios, moderação e preços observados.
8. Implementar OAuth MCP e hospedagem HTTPS para o ChatGPT.
