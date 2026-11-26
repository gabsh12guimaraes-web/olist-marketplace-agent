import type { Config } from '../config.ts';
import type { AdapterDescriptor, MarketplaceProvider } from './contracts.ts';
// Status is derived from configuration, never assumed. 'implemented' is reserved for adapters validated against the real API;
// none of the marketplace adapters has been, so the best status reachable here is awaiting_credentials/awaiting_permission.
interface Static { credentials: (keyof Config)[]; codeReady: string[]; blockers: string[]; docs: string[]; needsPartnerApproval: boolean }
const registry: Record<MarketplaceProvider, Static> = {
  'mercado-livre': { credentials: ['ML_CLIENT_ID', 'ML_CLIENT_SECRET'], needsPartnerApproval: false, codeReady: [],
    blockers: ['Criar aplicação no DevCenter e autorizar com o usuário ADMINISTRADOR da conta (operador recebe invalid_operator_user_id).',
      'Refresh token de uso único (6 meses); sem chamadas por 4 meses o token é revogado.',
      'Itens com automação de preços rejeitam PUT de preço (item.price.not_modifiable); estoque distribuído exige x-version.'],
    docs: ['https://developers.mercadolivre.com.br/pt_br/autenticacao-e-autorizacao', 'https://developers.mercadolivre.com.br/pt_br/api-de-precos', 'https://developers.mercadolivre.com.br/pt_br/gerenciar-moderacoes'] },
  nuvemshop: { credentials: ['NUVEMSHOP_CLIENT_ID', 'NUVEMSHOP_CLIENT_SECRET'], needsPartnerApproval: false, codeReady: [],
    blockers: ['Criar app no Portal de Parceiros Nuvemshop (URLs, webhooks de privacidade e escopos) e instalar na loja.', 'Sem conceito de moderação/anúncio rejeitado na API.'],
    docs: ['https://tiendanube.github.io/api-documentation/authentication', 'https://tiendanube.github.io/api-documentation/resources/product-variant'] },
  shopee: { credentials: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'], needsPartnerApproval: true, codeReady: [],
    blockers: ['Cadastro no Shopee Open Platform como Registered Business Seller ou ISV, com documentos empresariais brasileiros e aprovação do perfil.',
      'Autorização do vendedor expira (máx. 365 dias); access token 4 h, refresh 30 dias.'],
    docs: ['https://open.shopee.com/developer-guide/12', 'https://open.shopee.com/developer-guide/20'] },
  'tiktok-shop': { credentials: ['TIKTOK_APP_KEY', 'TIKTOK_APP_SECRET'], needsPartnerApproval: true, codeReady: [],
    blockers: ['Conta no Partner Center, onboarding de desenvolvedor e revisão do app com escopos de produto/estoque/pedido; requisitos específicos do Brasil não confirmados.'],
    docs: ['https://partner.tiktokshop.com/docv2/page/authorization-overview-202407', 'https://partner.tiktokshop.com/docv2/page/sign-your-api-request'] },
  shein: { credentials: ['SHEIN_APP_ID', 'SHEIN_APP_SECRET'], needsPartnerApproval: true, codeReady: [],
    blockers: ['Conta de desenvolvedor com revisão de qualificação (tipo não pode ser alterado), revisão do app e autorização do vendedor.',
      'Produção exige IP fixo em whitelist (erro openapi00002) — hospedagem com IP de saída estável é necessária.', 'Alterações de preço passam por revisão da SHEIN.'],
    docs: ['https://open.sheincorp.com/documents/system/dad0d1c7-be76-4b03-a735-4e23f012bdd9', 'https://open.sheincorp.com/documents/system/2169474d-1d4a-41a9-b9fd-427f63f54a63'] }
};
export function marketplaceStatus(config: Config): AdapterDescriptor[] {
  return (Object.entries(registry) as [MarketplaceProvider, Static][]).map(([provider, r]) => {
    const configured = r.credentials.every(k => typeof config[k] === 'string' && (config[k] as string).length > 0);
    return { provider, status: configured ? (r.needsPartnerApproval ? 'awaiting_permission' : 'awaiting_credentials') : 'awaiting_credentials',
      capabilities: [], codeReady: r.codeReady, blockers: configured ? ['Credenciais presentes, mas a conta ainda não foi autorizada nem validada.', ...r.blockers] : r.blockers, docs: r.docs };
  });
}
export const olistDescriptor: AdapterDescriptor = { provider: 'olist', status: 'implemented',
  capabilities: ['catalog:read', 'stock:read', 'price-lists:read'],
  codeReady: ['deposits:read', 'categories:read', 'brands:read', 'intermediaries:read', 'stock-logs:read', 'orders:read', 'stock:write', 'price:write', 'product:write(bloqueado)'],
  blockers: ['Intermediadores: HTTP 403 (permissão do módulo).', 'Escritas: exigem permissão de edição no aplicativo e WRITE_MODE=enabled.'], docs: ['https://api-docs.erp.olist.com/'] };
