import { describe, expect, it } from 'vitest';
import { Webhook } from 'standardwebhooks';
import { callbacks, publicAddress, safePost, secretBox } from '../apps/server/src/callback.js';
import { fixtureSecret } from './harness.js';

describe('callback unit tests', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1'])('blocks nonpublic address %s', value => { expect(publicAddress(value)).toBe(false); });
  it('accepts a public unicast address', () => { expect(publicAddress('8.8.8.8')).toBe(true); });
  it('blocks an allowlisted loopback target after resolving it, before making an HTTPS request', async () => {
    await expect(safePost(['127.0.0.1'])('https://127.0.0.1/callback', '{}', {})).rejects.toMatchObject({ code: 'CALLBACK_REJECTED' });
  });
  it.each(['http://allowed.invalid/callback', 'https://user:pass@allowed.invalid/callback', 'https://allowed.invalid:8443/callback', 'https://not-allowed.invalid/callback', 'https://allowed.invalid/callback#fragment'])('rejects unsafe URL before network I/O: %s', async url => { await expect(safePost(['allowed.invalid'])(url, '{}', {})).rejects.toMatchObject({ code: 'CALLBACK_REJECTED' }); });
  it('encrypts secrets and fails closed with a different key', () => { const a = secretBox(Buffer.alloc(32, 1)); const b = secretBox(Buffer.alloc(32, 2)); const encrypted = a.seal(fixtureSecret); expect(a.open(encrypted)).toBe(fixtureSecret); expect(() => b.open(encrypted)).toThrow(); });
  it('signs exact bytes; modified payload cannot verify', async () => {
    const cb = callbacks(async (_url, body, headers) => { expect(() => new Webhook(fixtureSecret).verify(`${body} `, headers)).toThrow(); return { status: 204, body: '' }; });
    await cb.send({ id: 's', connectionId: 'b', roomId: 'r', secret: fixtureSecret, expiresAt: Date.now() + 10000, tokenExpiresAt: Date.now() + 10000, url: 'https://receiver.invalid', active: true }, { eventId: 'e', data: {} });
  });
  it('dual-signs the bounded rotation window so either secret verifies', async () => {
    const next = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
    const cb = callbacks(async (_url, body, headers) => { expect(new Webhook(fixtureSecret).verify(body, headers)).toMatchObject({ eventId: 'e' }); expect(new Webhook(next).verify(body, headers)).toMatchObject({ eventId: 'e' }); return { status: 204, body: '' }; });
    await cb.send({ id: 's', connectionId: 'b', roomId: 'r', secret: next, oldSecret: fixtureSecret, expiresAt: Date.now() + 10000, tokenExpiresAt: Date.now() + 10000, url: 'https://receiver.invalid', active: true }, { eventId: 'e', data: {} });
  });
});
