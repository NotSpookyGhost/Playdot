import { afterEach, expect, it, vi } from 'vitest';
import { runtimeMode } from '../apps/server/src/config.js';
import { buildApp } from '../apps/server/src/app.js';
import { Fault } from '../packages/domain/src/model.js';
import type { Playdot } from '../packages/domain/src/service.js';

afterEach(() => vi.unstubAllEnvs());
it('packaged runtime defaults locked, rejects mock modes and permits OIDC setup', () => {
  vi.stubEnv('PLAYDOT_MODE', undefined); vi.stubEnv('PLAYDOT_ENABLE_REAL_ROOMS', undefined);
  expect(runtimeMode()).toBe('locked'); expect(() => runtimeMode('mock')).toThrow(); expect(runtimeMode('oidc')).toBe('oidc');
});
it('locked health is honest, database readiness fails closed, and MCP cannot reach domain state', async () => {
  let ready = false;
  const app = buildApp({ service: {} as Playdot, authenticate: async () => { throw new Fault('UNAUTHORIZED', 401); }, resource: 'https://playdot.bytedev.app/mcp', issuer: 'https://locked.playdot.invalid', mode: 'locked', ready: async () => { if (!ready) throw new Error('private database diagnostic'); } });
  try {
    expect((await app.inject('/health')).json()).toMatchObject({ mode: 'locked', real_rooms_enabled: false, real_dot_verified: false });
    const failed = await app.inject('/ready'); expect(failed.statusCode).toBe(503); expect(failed.body).not.toContain('private');
    ready = true; expect((await app.inject('/ready')).statusCode).toBe(200);
    for (const authorization of [undefined, 'Bearer fake-test-token']) {
      const result = await app.inject({ method: 'POST', url: '/mcp', headers: authorization ? { authorization } : {}, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
      expect(result.statusCode).toBe(401);
    }
  } finally { await app.close(); }
});
