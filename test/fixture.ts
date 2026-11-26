import { loadConfig } from '../src/config.ts';
export const config = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'http://localhost:3000', DATABASE_URL: 'postgresql://unused',
  MCP_BEARER_TOKEN: 'm'.repeat(40), ADMIN_BEARER_TOKEN: 'a'.repeat(40), TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
  OLIST_ACCOUNT_ID: 'test-account', OLIST_CLIENT_ID: 'test-client', OLIST_CLIENT_SECRET: 'test-secret', OLIST_REDIRECT_URI: 'http://localhost:3000/oauth/olist/callback' });
