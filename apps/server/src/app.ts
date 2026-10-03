import { registerOwner, type OwnerLogin } from './owner.js';
import type { Pilot } from '../../../packages/domain/src/pilot.js';
import Fastify, { type FastifyRequest } from 'fastify';
import { diagnostic, type DiagnosticSink } from './diagnostics.js';
import { protocolRequest, initializeVersion, listParams, ProtocolFailure } from './protocol.js';
import { z, ZodError } from 'zod';
import { SUPPORTED_PROTOCOLS, empty, eventDefinition, scopes, toolDefinitions } from '../../../packages/contracts/src/index.js';
import { Fault } from '../../../packages/domain/src/model.js';
import type { Playdot } from '../../../packages/domain/src/service.js';
import { AuthenticationFailure, type Authenticate } from './auth.js';

const rpc = z.strictObject({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number()]).optional(), method: z.string().max(128), params: z.unknown().optional() });
const call = z.strictObject({ name: z.string(), arguments: z.unknown().optional() });
export function buildApp(options: { service: Playdot; authenticate: Authenticate; resource: string; issuer: string; mode?: 'locked' | 'oidc'; realRooms?: boolean; discoveryClientIds?: string[]; ready?: () => Promise<void>; diagnosticSink?: DiagnosticSink; owner?: { pilot: Pilot; login: OwnerLogin; origin: string; now?: () => number } }) {
  const app = Fastify({ logger: false, requestIdHeader: false, bodyLimit: 32 * 1024, trustProxy: false });
  const diagnostics = new WeakMap<FastifyRequest, ReturnType<typeof diagnostic>>();
  const trace = (req: FastifyRequest) => {
    let value = diagnostics.get(req);
    if (!value) { value = diagnostic(options.diagnosticSink); diagnostics.set(req, value); }
    return value;
  };
  const serverInfo = { name: 'playdot', version: '0.0.1' };
  const stage = options.mode === 'oidc' && !options.realRooms ? '0B-oauth-setup' : options.owner ? '0B-prepared' : '0A';
  const capabilities = () => ({ tools: {}, ...(options.service.eventsEnabled ? { events: {} } : {}) });
  const authorize = async (req: FastifyRequest) => {
    const log = trace(req);
    let principal;
    try { principal = await options.authenticate(req.headers.authorization); }
    catch (error) {
      log.emit(error instanceof AuthenticationFailure ? error.phase : 'token', error instanceof AuthenticationFailure ? error.reason : 'TOKEN_INVALID');
      throw error;
    }
    log.emit('token', 'TOKEN_OK');
    try {
      if (options.discoveryClientIds) await options.service.authorizeDiscovery(principal, options.discoveryClientIds);
      else await options.service.status(principal);
    } catch (error) {
      if (!(error instanceof Fault)) log.emit('internal', 'INTERNAL_FAILURE');
      else log.emit('authorization', options.discoveryClientIds && !options.discoveryClientIds.includes(principal.clientId) ? 'CLIENT_DENIED'
        : options.discoveryClientIds && !principal.scopes.includes('room:read') ? 'SCOPE_DENIED'
        : error.code === 'CONNECTION_NOT_AUTHORIZED' ? 'CONNECTION_DENIED' : 'AUTHORIZATION_DENIED');
      throw error;
    }
    log.emit('authorization', 'AUTHORIZED');
    return principal;
  };
  const metadata = `${new URL(options.resource).origin}/.well-known/oauth-protected-resource`;
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (req.routeOptions.url === '/mcp') reply.header('X-Playdot-Correlation-Id', trace(req).correlationId);
    // Browser requests are restricted to same-origin human control routes.
    if (req.headers.origin && !(options.owner && req.url.startsWith('/owner') && req.headers.origin === options.owner.origin)) { if (req.routeOptions.url === '/mcp') trace(req).emit('protocol', 'ORIGIN_DENIED'); return reply.code(403).send({ code: 'ORIGIN_NOT_ALLOWED' }); }
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
    try { await authorize(req); trace(req).emit('protocol', 'GET_NOT_SUPPORTED'); return reply.code(405).header('Allow', 'POST').send(); }
    catch (error) { const status = error instanceof Fault ? error.status : 500; if (status === 401) reply.header('WWW-Authenticate', `Bearer resource_metadata="${metadata}"`); return reply.code(status).send({ code: error instanceof Fault ? error.code : 'INTERNAL_ERROR' }); }
  });
  app.post('/mcp', async (req, reply) => {
    let id: string | number | null = null;
    let authorized = false;
    let parsed = false;
    try {
      const principal = await authorize(req); authorized = true;
      const message = rpc.parse(req.body); id = message.id ?? null; parsed = true;
      const { modern, params } = protocolRequest(message.method, message.params, req.headers);
      if (message.id === undefined) {
        if (message.method === 'notifications/initialized') { trace(req).emit('protocol', 'INITIALIZED'); return reply.code(202).send(); }
        throw new ProtocolFailure('INVALID_REQUEST', -32600);
      }
      let result: unknown;
      switch (message.method) {
        case 'server/discover':
          empty.parse(params);
          result = { resultType: 'complete', supportedVersions: SUPPORTED_PROTOCOLS, capabilities: capabilities(), _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo } }; break;
        case 'initialize': {
          result = { protocolVersion: initializeVersion(params), capabilities: capabilities(), serverInfo }; break;
        }
        case 'ping': result = {}; break;
        case 'tools/list':
          const page = listParams.parse(params);
          if (page.cursor) throw new ProtocolFailure('INVALID_PARAMS', -32602);
          result = { tools: toolDefinitions.map(t => ({ name: t.name, description: t.description, inputSchema: z.toJSONSchema(t.schema), annotations: { readOnlyHint: t.read, destructiveHint: false, idempotentHint: true, openWorldHint: false }, securitySchemes: [{ type: 'oauth2', scopes: t.read ? ['room:read'] : ['message:write'] }] })) }; break;
        case 'tools/call': {
          const args = call.parse(params); let value: unknown;
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
            result = { content: [{ type: 'text', text: code }], structuredContent: { code, request_id: trace(req).correlationId, ...(error instanceof Fault ? error.details : {}) }, isError: true };
          }
          break;
        }
        case 'events/list': empty.parse(params); result = { events: await options.service.canSubscribe(principal) ? [eventDefinition] : [] }; break;
        case 'events/subscribe': result = await options.service.subscribe(principal, params); break;
        case 'events/unsubscribe': result = await options.service.unsubscribe(principal, params); break;
        default: trace(req).emit('protocol', 'METHOD_NOT_FOUND'); return reply.code(modern ? 404 : 200).send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      }
      trace(req).emit('protocol', message.method === 'initialize' ? 'INITIALIZE_OK' : message.method === 'server/discover' ? 'DISCOVER_OK' : message.method === 'tools/list' ? 'TOOLS_LIST_OK' : 'RPC_OK');
      return reply.send({ jsonrpc: '2.0', id, result: modern ? { ...(result as object), resultType: 'complete' } : result });
    } catch (error) {
      if (authorized) trace(req).emit(error instanceof Fault || error instanceof ZodError ? 'protocol' : 'internal', error instanceof ProtocolFailure ? error.reason : error instanceof ZodError ? (parsed ? 'INVALID_PARAMS' : 'INVALID_REQUEST') : error instanceof Fault ? 'OPERATION_DENIED' : 'INTERNAL_FAILURE');
      if (error instanceof ProtocolFailure) return reply.code(400).send({ jsonrpc: '2.0', id, error: { code: error.rpcCode, message: error.code, data: error.data } });
      const fault = error instanceof Fault ? error : new Fault(error instanceof ZodError ? 'INVALID_ARGUMENTS' : 'INTERNAL_ERROR', error instanceof ZodError ? 400 : 500);
      if (fault.status === 401) reply.header('WWW-Authenticate', `Bearer resource_metadata="${metadata}"`);
      const rpcCode = fault.code === 'CALLBACK_VERIFICATION_FAILED' ? -32015 : error instanceof ZodError ? (parsed ? -32602 : -32600) : -32000;
      return reply.code(fault.status === 401 || fault.status === 500 ? fault.status : 200).send({ jsonrpc: '2.0', id, error: { code: rpcCode, message: fault.code, data: { code: fault.code, request_id: trace(req).correlationId, ...(rpcCode === -32015 ? { reason: 'challenge_failed' } : {}) } } });
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (req.routeOptions.url === '/mcp') {
      const status = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      const clientError = status >= 400 && status < 500;
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      const reason = code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ? 'HTTP_CONTENT_TYPE_REJECTED'
        : code === 'FST_ERR_CTP_INVALID_JSON_BODY' ? 'HTTP_JSON_INVALID'
        : code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ? 'HTTP_BODY_EMPTY'
        : code === 'FST_ERR_CTP_BODY_TOO_LARGE' ? 'HTTP_BODY_TOO_LARGE' : 'HTTP_PARSE_REJECTED';
      trace(req).emit(clientError ? 'protocol' : 'internal', clientError ? reason : 'INTERNAL_FAILURE');
      return reply.code(clientError ? status : 500).send({ code: clientError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR' });
    }
    return reply.code(500).send({ code: 'INTERNAL_ERROR' });
  });
  return app;
}
