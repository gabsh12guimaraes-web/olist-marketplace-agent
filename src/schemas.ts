import { z } from 'zod';
// Validated projections of the official OpenAPI snapshot in docs/olist-openapi.json.
// Unknown fields are stripped; fields not marked required upstream remain optional.
export const id = z.number().int().positive().safe();
export const page = { limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).max(10000000).default(0) };
const text = z.string().nullable().optional();
const num = z.number().finite().nullable().optional();
export const prices = z.object({ preco: num, precoPromocional: num, precoCusto: num, precoCustoMedio: num });
const stockSummary = z.object({ controlar: z.boolean().nullable().optional(), sobEncomenda: z.boolean().nullable().optional(), diasPreparacao: z.number().int().nullable().optional(), minimo: num, maximo: num, localizacao: text, quantidade: num });
export const variant = z.object({ id: id.nullable().optional(), sku: text, descricao: text, gtin: text,
  precos: prices.optional(), estoque: stockSummary.optional(), grade: z.array(z.object({ chave: z.string(), valor: z.string() })).nullable().optional() });
export const product = z.object({ id: id.nullable().optional(), sku: text, descricao: text, tipo: text, situacao: text, tipoVariacao: text,
  precos: prices.optional(), estoque: stockSummary.optional(), variacoes: z.array(variant).optional() });
export const pagination = z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() });
export const productList = z.object({ itens: z.array(product), paginacao: pagination });
const depot = z.object({ id: id.optional(), nome: z.string().optional(), desconsiderar: z.boolean().optional(), saldo: num, reservado: num, disponivel: num, empresa: z.string().optional() });
export const stock = z.object({ id: id.optional(), nome: z.string().optional(), codigo: z.string().optional(), unidade: z.string().optional(), saldo: num, reservado: num, disponivel: num, localizacao: text, depositos: z.array(depot).optional() });
const stockItem = stock.omit({ id: true, codigo: true, unidade: true }).extend({ idProduto: id.optional(), sku: z.string().optional() });
export const stockList = z.object({ itens: z.array(stockItem), paginacao: pagination });
export const priceList = z.object({ id: id.optional(), descricao: text, acrescimoDesconto: num,
  excecoes: z.object({ idProduto: id.nullable().optional(), codigo: text, preco: num, precoPromocional: num }).optional() });
export const priceLists = z.object({ itens: z.array(priceList), paginacao: pagination });
export const productFilters = { ...page, nome: z.string().min(1).max(200).optional(), codigo: z.string().min(1).max(200).optional(), gtin: z.string().regex(/^\d{8,14}$/).optional(), situacao: z.enum(['A','I','E']).optional(), idListaPreco: id.optional() };
const deposit = z.object({ id: id, descricao: text, tipo: text, desconsideraSaldo: z.boolean().nullable().optional(), padrao: z.boolean().nullable().optional(), possuiReserva: z.boolean().nullable().optional() });
// The OpenAPI snapshot documents a bare array; the live API returned an object wrapper. Accept both, return the array.
export const deposits = z.union([z.array(deposit), z.object({ itens: z.array(deposit) }).passthrough().transform(v => v.itens)]);
const named = z.object({ id: id, descricao: text });
export const brands = z.object({ itens: z.array(named), paginacao: pagination });
type Category = { id: number; descricao?: string | null; filhas?: Category[] };
export const category: z.ZodType<Category> = z.lazy(() => z.object({ id: id, descricao: text, filhas: z.array(category).optional() }));
export const categories = z.union([z.array(category), category]);
// Intermediary fields are not detailed in the official schema; keep only identifying fields.
export const intermediaries = z.object({ itens: z.array(z.object({ id: id.optional(), nome: text, cnpj: text }).passthrough().transform(({ id, nome, cnpj }) => ({ id, nome, cnpj }))), paginacao: pagination });
// Orders: customer personal data is deliberately dropped from the projection.
export const orders = z.object({ itens: z.array(z.object({ id: id, situacao: z.number().int().nullable().optional(), numeroPedido: z.number().int().nullable().optional(),
  ecommerce: z.object({ id: z.number().nullable().optional(), nome: text, numeroPedidoEcommerce: text }).partial().nullable().optional(),
  dataCriacao: text, dataPrevista: text, valor: z.union([z.string(), z.number()]).nullable().optional(), origemPedido: z.number().int().nullable().optional() })), paginacao: pagination });
