export type Provider = 'olist' | 'shopee' | 'mercado-livre' | 'shein' | 'nuvemshop' | 'tiktok-shop';
export const marketplaceProviders = ['shopee', 'mercado-livre', 'shein', 'nuvemshop', 'tiktok-shop'] as const;
export type MarketplaceProvider = typeof marketplaceProviders[number];
// `capabilities` lists only what was validated against the real API. Code that exists but was never
// authenticated goes to `codeReady`, so nothing unauthenticated is presented as operational.
export interface AdapterDescriptor {
  provider: Provider;
  status: 'implemented' | 'awaiting_credentials' | 'awaiting_permission' | 'unverified';
  capabilities: readonly string[];
  codeReady: readonly string[];
  blockers: readonly string[];
  docs: readonly string[];
}
export interface ReadAdapter { get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> }
export type WriteMethod = 'POST' | 'PUT' | 'DELETE';
export interface WriteAdapter { send(method: WriteMethod, path: string, body: unknown): Promise<unknown> }
