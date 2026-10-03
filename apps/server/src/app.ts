import { registerOwner, type OwnerLogin } from './owner.js';
import type { Pilot } from '../../../packages/domain/src/pilot.js';
import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { PROTOCOL, empty, eventDefinition, scopes, toolDefinitions } from '../../../packages/contracts/src/index.js';
import { Fault } from '../../../packages/domain/src/model.js';
import type { Playdot } from '../../../packages/domain/src/service.js';
import type { Authenticate } from './auth.js';

const rpc = z.strictObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number()]).optional(), method: z.string().max(128), params: z.unknown().optional() });
const call = z.strictObject({ name: z.string(), arguments: z.unknown().optional() });
export function buildApp(options: { service: Playdot; authenticate: Authenticate; resource: string; issuer: string; mode?: 'locked' | 'oidc'; realRooms?: boolean; discoveryClientIds?: string[]; ready?: () => Promise<void>; owner?: { pilot: Pilot; login: OwnerLogin; origin: string; now?: () => number } }) {
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024, trustProxy: false });
  const stage = options.mode === 'oidc' && !options.realRooms ? '0B-oauth-setup' : options.owner ? '0B-prepared' : '0A';
  const capabilities = () => ({ tools: {}, ...(options.service.eventsEnabled ? { events: {} } : {}) });
  const authorize = async (header: string | undefined) => {
    const principal = await options.authenticate(header);
    if (options.discoveryClientIds) await options.service.authorizeDiscovery(principal, options.discoveryClientIds);
    else await options.service.status(principal);
    return principal;
  };
  const metadata = `${new URL(options.resource).origin}/.well-known/oauth-protected-resource`;
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Browser requests are restricted to same-origin human control routes.
    if (req.headers.origin && !(options.owner && req.url.startsWith('/owner') && req.headers.origin === options.owner.origin)) return reply.code(403).send({ code: 'ORIGIN_NOT_ALLOWED' });
  });
  if (options.owner) registerOwner(app, options.owner);
  app.get('/health', async () => ({ status: 'ok', stage, real_dot_verified: false, ...(options.mode ? { mode: options.mode, real_rooms_enabled: options.realRooms === true, events_enabled: options.service.eventsEnabled === true, worker_enabled: options.service.eventsEnabled === true } : {}) }));
  app.get('/ready', async (_req, reply) => {
    try { await options.ready?.(); return { status: 'ready', stage }; }
    catch { return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.get('/.well-known/oauth-protected-resource', async () => ({ resource: options.resource, authorization_servers: [options.issuer], scopes_supported: scopes, bearer_methods_supported: ['header'] }));
  app.get('/.well-known/oauth-protected-resource/mcp', async () => ({ resource: options.resource, authorization_servers: [options.issuer], scopes_supported: scopes, bearer_methods_supported: ['header'] }));
  app.get('/mcp', async (req, reply) => {
    try { await authorize(req.headers.authorization); return reply.code(405).header('Allow', 'POST').send(); }
    catch (error) { const status = error instanceof Fault ? error.status : 500; if (status === 401) reply.header('WWW-Authenticate', `Bearer resource_metadata="${metadata}"`); return reply.code(status).send({ code: error instanceof Fault ? error.code : 'INTERNAL_ERROR' }); }
  });
  app.post('/mcp', async (req, reply) => {
    let id: string | number | null = null;
    try {
      const principal = await authorize(req.headers.authorization);
      const message = rpc.parse(req.body); id = message.id ?? null;
      const version = req.headers['mcp-protocol-version'];
      if (version && version !== PROTOCOL) throw new Fault('UNSUPPORTED_PROTOCOL', 400);
      if (message.id === undefined) {
        if (message.method === 'notifications/initialized') return reply.code(202).send();
        throw new Fault('REQUEST_ID_REQUIRED', 400);
      }
      let result: unknown;
      switch (message.method) {
        case 'server/discover':
          result = { resultType: 'complete', supportedVersions: [PROTOCOL], capabilities: capabilities() }; break;
        case 'initialize': {
          const params = z.object({ protocolVersion: z.literal(PROTOCOL) }).parse(message.params);
          result = { protocolVersion: params.protocolVersion, capabilities: capabilities(), serverInfo: { name: options.owner ? 'playdot-stage-0b' : 'playdot-stage-0a', version: '0.0.1' } }; break;
        }
        case 'ping': result = {}; break;
        case 'tools/list':
          empty.parse(message.params ?? {});
          result = { tools: toolDefinitions.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema), annotations: { readOnlyHint: t.read, destructiveHint: false, idempotentHint: true, openWorldHint: false }, securitySchemes: [{ type: 'oauth2', scopes: t.read ? ['room:read'] : ['message:write'] }] })) }; break;
        case 'tools/call': {
          const args = call.parse(message.params); let value: unknown;
          try {
            switch (args.name) {
              case 'playdot_connection_status': empty.parse(args.arguments ?? {}); value = await options.service.status(principal); break;
              case 'playdot_get_room': value = await options.service.room(principal, args.arguments); break;
              case 'playdot_read_messages': value = await options.service.read(principal, args.arguments); break;
              case 'playdot_send_message': value = await options.service.send(principal, args.arguments); break;
              default: throw new Fault('UNKNOWN_TOOL', 404);
            }
            result = { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
          } catch (error) {
            if (!(error instanceof Fault) && !(error instanceof ZodError)) throw error;
            const code = error instanceof Fault ? error.code : 'INVALID_ARGUMENTS';
            result = { content: [{ type: 'text', text: code }], structuredContent: { code, request_id: req.id, ...(error instanceof Fault ? error.details : {}) }, isError: true };
          }
          break;
        }
        case 'events/list': empty.parse(message.params ?? {}); result = { events: await options.service.canSubscribe(principal) ? [eventDefinition] : [] }; break;
        case 'events/subscribe': result = await options.service.subscribe(principal, message.params); break;
        case 'events/unsubscribe': result = await options.service.unsubscribe(principal, message.params); break;
        default: return reply.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      }
      return reply.send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      const fault = error instanceof Fault ? error : new Fault(error instanceof ZodError ? 'INVALID_ARGUMENTS' : 'INTERNAL_ERROR', error instanceof ZodError ? 400 : 500);
      if (fault.status === 401) reply.header('WWW-Authenticate', `Bearer resource_metadata="${metadata}"`);
      const rpcCode = fault.code === 'CALLBACK_VERIFICATION_FAILED' ? -32015 : error instanceof ZodError ? -32602 : -32000;
      return reply.code(fault.status === 401 || fault.status === 500 ? fault.status : 200).send({ jsonrpc: '2.0', id, error: { code: rpcCode, message: fault.code, data: { code: fault.code, request_id: req.id, ...(rpcCode === -32015 ? { reason: 'challenge_failed' } : {}) } } });
    }
  });
  return app;
}
