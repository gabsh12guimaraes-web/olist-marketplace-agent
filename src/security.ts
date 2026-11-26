import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const nonce = () => randomBytes(32).toString('base64url');
export function authorized(header: string | undefined, secret: string): boolean {
  if (!header?.startsWith('Bearer ') || header.length > 4096) return false;
  return timingSafeEqual(Buffer.from(digest(header.slice(7)), 'hex'), Buffer.from(digest(secret), 'hex'));
}
export function seal(value: unknown, key: string, account: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  cipher.setAAD(Buffer.from(account));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(b => b.toString('base64url')).join('.');
}
export function unseal(value: string, key: string, account: string): unknown {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted token');
  const [iv, tag, data] = parts.map(p => Buffer.from(p, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv!);
  cipher.setAAD(Buffer.from(account)); cipher.setAuthTag(tag!);
  return JSON.parse(Buffer.concat([cipher.update(data!), cipher.final()]).toString('utf8'));
}
