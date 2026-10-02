import { createCipheriv, createDecipheriv, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';
import { Fault, type Subscription } from '../../../packages/domain/src/model.js';
import type { Callback, Secrets } from '../../../packages/domain/src/service.js';

export function secretBox(key: Uint8Array): Secrets {
  if (key.length !== 32) throw new Error('Expected a separately provisioned 32-byte encryption key');
  return {
    seal(value) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'); },
    open(value) { const b = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12)); cipher.setAuthTag(b.subarray(12, 28)); return Buffer.concat([cipher.update(b.subarray(28)), cipher.final()]).toString('utf8'); }
  };
}
export type Post = (url: string, body: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;
export function publicAddress(address: string) {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}
export function safePost(allowedHosts: string[]): Post {
  return async (target, body, headers) => {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443') || !allowedHosts.includes(url.hostname)) throw new Fault('CALLBACK_REJECTED', 422);
    let dnsDeadline: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_resolve, reject) => { dnsDeadline = setTimeout(() => reject(new Error('DNS timeout')), 3000); })
    ]).finally(() => clearTimeout(dnsDeadline));
    if (!addresses.length || addresses.some(x => !publicAddress(x.address))) throw new Fault('CALLBACK_REJECTED', 422);
    const address = addresses[0]!;
    return new Promise((resolve, reject) => {
      // DNS result is pinned for this socket; hostname remains the TLS servername.
      const req = request(url, { method: 'POST', agent: false, headers, lookup: (_hostname, _options, done) => done(null, address.address, address.family) }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4096) response.destroy(new Error('Response too large')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      });
      const deadline = setTimeout(() => req.destroy(new Error('Callback timeout')), 10000);
      req.on('close', () => clearTimeout(deadline)); req.on('error', reject); req.end(body);
      // Native https does not follow redirects.
    });
  };
}
export function callbacks(post: Post, now: () => number = Date.now): Callback {
  const signed = async (url: string, secret: string, id: string, eventId: string, event: unknown, oldSecret?: string) => {
    const body = JSON.stringify(event); if (Buffer.byteLength(body) > 256 * 1024) throw new Fault('EVENT_TOO_LARGE', 413);
    const at = new Date(now());
    const signatures = [new Webhook(secret).sign(eventId, at, body)];
    if (oldSecret) signatures.push(new Webhook(oldSecret).sign(eventId, at, body));
    return post(url, body, { 'Content-Type': 'application/json', 'webhook-id': eventId, 'webhook-timestamp': String(Math.floor(at.getTime() / 1000)), 'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': id });
  };
  return {
    async verify(url, secret, id) {
      try {
        const challenge = randomBytes(24).toString('hex');
        const result = await signed(url, secret, id, randomUUID(), { type: 'verification', challenge });
        const value: unknown = JSON.parse(result.body).challenge;
        if (result.status < 200 || result.status >= 300 || typeof value !== 'string' || value.length !== challenge.length || !timingSafeEqual(Buffer.from(value), Buffer.from(challenge))) throw new Error('Failed challenge');
      } catch { throw new Fault('CALLBACK_VERIFICATION_FAILED', 422); }
    },
    async send(sub: Subscription, event) { return (await signed(sub.url, sub.secret, sub.id, (event as { eventId: string }).eventId, event, sub.oldSecret)).status; }
  };
}
