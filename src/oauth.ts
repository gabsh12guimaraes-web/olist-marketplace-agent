import { z } from 'zod';
import type { Config } from './config.ts';
import { transaction, type Pool } from './db.ts';
import { digest, nonce, seal, unseal } from './security.ts';

export const AUTH_URL = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth';
export const TOKEN_URL = 'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';
const tokens = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1), expires_at: z.number() });
const responseSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().min(1).optional(), expires_in: z.number().positive(), token_type: z.string().refine(s => s.toLowerCase() === 'bearer') });
export type TokenSet = z.infer<typeof tokens>;
export class OAuth {
  readonly pool: Pool; readonly config: Config; readonly request: typeof fetch;
  constructor(pool: Pool, config: Config, request = fetch) { this.pool = pool; this.config = config; this.request = request; }
  async start() {
    const state = nonce(), binding = nonce();
    await this.pool.query('DELETE FROM oauth_states WHERE expires_at <= now()');
    await this.pool.query(`INSERT INTO oauth_states(state_hash,binding_hash,account_id,expires_at)
      VALUES($1,$2,$3,now()+interval '10 minutes')`, [digest(state), digest(binding), this.config.OLIST_ACCOUNT_ID]);
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({ client_id: this.config.OLIST_CLIENT_ID, redirect_uri: this.config.OLIST_REDIRECT_URI, response_type: 'code', scope: 'openid', state }).toString();
    return { url: url.toString(), binding };
  }
  async callback(code: string, state: string, binding: string) {
    // Consume atomically before exchange: no replay, including on failed exchange.
    const consumed = await this.pool.query(`DELETE FROM oauth_states WHERE state_hash=$1 AND binding_hash=$2
      AND account_id=$3 AND expires_at>now() RETURNING account_id`, [digest(state), digest(binding), this.config.OLIST_ACCOUNT_ID]);
    if (consumed.rowCount !== 1) throw new Error('Invalid OAuth state');
    await transaction(this.pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth:${this.config.OLIST_ACCOUNT_ID}`]);
      const result = await this.exchange({ grant_type: 'authorization_code', code, redirect_uri: this.config.OLIST_REDIRECT_URI });
      await db.query(`INSERT INTO oauth_tokens(account_id,encrypted_payload) VALUES($1,$2)
        ON CONFLICT(account_id) DO UPDATE SET encrypted_payload=EXCLUDED.encrypted_payload,updated_at=now()`,
      [this.config.OLIST_ACCOUNT_ID, seal(result, this.config.TOKEN_ENCRYPTION_KEY, this.config.OLIST_ACCOUNT_ID)]);
    });
  }
  async exchange(fields: Record<string, string>, previous?: TokenSet): Promise<TokenSet> {
    const res = await this.request(TOKEN_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, client_id: this.config.OLIST_CLIENT_ID, client_secret: this.config.OLIST_CLIENT_SECRET }) });
    if (!res.ok) throw new Error('OAuth exchange failed; authorize again if refresh token expired');
    const result = responseSchema.parse(await res.json());
    const refresh = result.refresh_token ?? previous?.refresh_token;
    if (!refresh) throw new Error('Missing refresh token');
    return { access_token: result.access_token, refresh_token: refresh, expires_at: Date.now() + result.expires_in * 1000 };
  }
  // Diagnostic view without secrets: whether authorized and when the access token expires.
  async status() {
    const row = await this.pool.query('SELECT encrypted_payload,updated_at FROM oauth_tokens WHERE account_id=$1', [this.config.OLIST_ACCOUNT_ID]);
    if (!row.rows[0]) return { autorizado: false, acao: 'Autorize em /oauth/olist/connect' };
    try {
      const t = tokens.parse(unseal(row.rows[0].encrypted_payload, this.config.TOKEN_ENCRYPTION_KEY, this.config.OLIST_ACCOUNT_ID));
      return { autorizado: true, accessTokenExpiraEm: new Date(t.expires_at).toISOString(), atualizadoEm: row.rows[0].updated_at,
        observacao: 'O access token é renovado automaticamente; a validade do refresh token não é informada pela Olist — falha de renovação exige nova autorização.' };
    } catch { return { autorizado: false, acao: 'Token ilegível (chave AES trocada ou dado corrompido); reautorize' }; }
  }
  // Keeps the refresh token alive while the server runs: refreshes ahead of expiry instead of waiting for the next tool call.
  async keepAlive(marginMs = 45 * 60_000): Promise<'refreshed' | 'fresh' | 'unauthorized'> {
    return transaction(this.pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth:${this.config.OLIST_ACCOUNT_ID}`]);
      const row = await db.query('SELECT encrypted_payload FROM oauth_tokens WHERE account_id=$1', [this.config.OLIST_ACCOUNT_ID]);
      if (!row.rows[0]) return 'unauthorized';
      const current = tokens.parse(unseal(row.rows[0].encrypted_payload, this.config.TOKEN_ENCRYPTION_KEY, this.config.OLIST_ACCOUNT_ID));
      if (current.expires_at > Date.now() + marginMs) return 'fresh';
      const next = await this.exchange({ grant_type: 'refresh_token', refresh_token: current.refresh_token }, current);
      await db.query('UPDATE oauth_tokens SET encrypted_payload=$2,updated_at=now() WHERE account_id=$1',
        [this.config.OLIST_ACCOUNT_ID, seal(next, this.config.TOKEN_ENCRYPTION_KEY, this.config.OLIST_ACCOUNT_ID)]);
      return 'refreshed';
    });
  }
  async accessToken(invalidToken?: string): Promise<string> {
    return transaction(this.pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`oauth:${this.config.OLIST_ACCOUNT_ID}`]);
      const row = await db.query('SELECT encrypted_payload FROM oauth_tokens WHERE account_id=$1', [this.config.OLIST_ACCOUNT_ID]);
      if (!row.rows[0]) throw new Error('Authorize Olist first');
      let current = tokens.parse(unseal(row.rows[0].encrypted_payload, this.config.TOKEN_ENCRYPTION_KEY, this.config.OLIST_ACCOUNT_ID));
      if (current.expires_at <= Date.now() + 60000 || current.access_token === invalidToken) {
        current = await this.exchange({ grant_type: 'refresh_token', refresh_token: current.refresh_token }, current);
        await db.query('UPDATE oauth_tokens SET encrypted_payload=$2,updated_at=now() WHERE account_id=$1',
          [this.config.OLIST_ACCOUNT_ID, seal(current, this.config.TOKEN_ENCRYPTION_KEY, this.config.OLIST_ACCOUNT_ID)]);
      }
      return current.access_token;
    });
  }
}
