# Contratos oficiais consultados

Verificação: 30/10/2026. Não foram usados exemplos de terceiros como contrato de integração.

- [Documentação técnica ERP V3](https://api-docs.erp.olist.com/).
- [Swagger oficial](https://erp.tiny.com.br/public-api/v3/swagger/index.html), indicado pela Central de Ajuda.
- [OpenAPI original](https://erp.tiny.com.br/public-api/v3/swagger/swagger.json): cópia integral em `olist-openapi.json`, versão declarada 3.1, SHA-256 `BC926A152427DFF664A6563AF223B08BECC750BE05BD068D97CB21B3637CAE6B`.
- [OAuth2](https://api-docs.erp.olist.com/documentacao/comecando/autenticacao).
- [Limites e headers](https://api-docs.erp.olist.com/documentacao/comecando/limites-de-consulta).
- [Aplicativos privados e permissões](https://api-docs.erp.olist.com/documentacao/comecando/criando-um-aplicativo).
- [Planos e limites por conta](https://ajuda.olist.com/pt_BR/hubs-e-plataformas-via-api/aplicativos-api-v3-configuracoes-e-utilizacao).
- [SDK TypeScript oficial v1](https://ts.sdk.modelcontextprotocol.io/server).
- [MCP no Codex](https://developers.openai.com/codex/mcp).

## Rotas implementadas

Base extraída de `servers[0].url` do OpenAPI: `https://api.tiny.com.br/public-api/v3`.

| GET | Schema de resposta | Uso |
| --- | --- | --- |
| `/produtos` | `itens: ListagemProdutosResponseModel[]`, `paginacao: PaginatedResultModel` | Produtos, SKUs, preços da página |
| `/produtos/{idProduto}` | `ObterProdutoModelResponse` | Produto, `variacoes: VariacaoProdutoResponseModel[]`, `precos: PrecoProdutoResponseModel` |
| `/estoque` | `itens: ListagemEstoqueItemResponseModel[]`, `paginacao` | Estoques paginados |
| `/estoque/{idProduto}` | `ObterEstoqueProdutoModelResponse` | Saldos e depósitos |
| `/listas-precos` | `itens: ListagemListaDePrecosModelResponse[]`, `paginacao` | Tabelas de preço |
| `/listas-precos/{idListaDePreco}` | `ObterListaDePrecosModelResponse` | Tabela; filtro `idProduto` documentado |

O filtro de SKU chama-se `codigo`, embora o campo de resposta seja `sku`. Paginação usa `limit`/`offset`. O teto local de 100 por página é uma política deste servidor, não uma garantia de máximo do ERP. As ferramentas não percorrem páginas implicitamente.

As rotas `/produtos/{idProduto}/preco`, `/produtos/{idProduto}/variacoes` e `/produtos/{idProduto}/variacoes/{idVariacao}` não possuem GET no snapshot. Consultas de preço e variação usam o detalhe do produto. Não se deduz uma rota de leitura a partir de rotas de escrita.

O OpenAPI declara `excecoes` como objeto `ExcecaoListaPrecoModel`, não array. Mantivemos esse contrato: uma resposta incompatível falha na validação, em vez de adivinhar formato. Também há conflito no enum `tipo` herdado de `ProdutoResponseModel` versus o detalhe; a projeção conserva esse campo como texto. Schemas Zod validam somente os campos consumidos e removem outros campos. Ausência de `precos`/`variacoes` é devolvida como `null`, sem inventar zero ou lista vazia.

## OAuth e limites

Autorização em `https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth`, `response_type=code`, `scope=openid`. Troca e refresh por POST form-urlencoded em `https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token`, usando client ID e secret. Este servidor acrescenta state e vínculo por cookie contra CSRF. Não envia scopes de leitura inventados: permissões somente leitura são configuradas no aplicativo ERP.

O vencimento usa `expires_in` da resposta, com margem de 60 segundos; não fixa a duração do access token no código. Refresh expirado exige autorização novamente. Não há dependência de renovação perpétua nem tentativa de manter login sem intervenção.

Limites são compartilhados entre aplicativos da conta. O padrão local é 30 leituras/minuto; ajuste ao plano e reserve capacidade para outros clientes. O limitador PostgreSQL coordena réplicas deste serviço. Headers `X-RateLimit-Remaining`, `X-RateLimit-Reset` (segundos até reset) e `Retry-After` suspendem novas chamadas. Em 429 a ferramenta retorna erro e não faz repetição imediata. 502/503/504 permitem até três tentativas totais com espera e jitter; 401 permite um refresh dentro desse orçamento. Nenhum retry em POST OAuth para evitar repetição de código de uso único.

As cinco integrações futuras estão apenas no registro `src/adapters/contracts.ts`, com status `unverified` e capacidades vazias. Endpoints, OAuth, limites e permissões desses provedores ainda precisam de pesquisa e testes próprios.
