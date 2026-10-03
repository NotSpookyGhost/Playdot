import { z } from 'zod';
import { PROTOCOL, SUPPORTED_PROTOCOLS } from '../../../packages/contracts/src/index.js';
import { Fault } from '../../../packages/domain/src/model.js';

export class ProtocolFailure extends Fault {
  constructor(public reason: 'UNSUPPORTED_VERSION' | 'HEADER_MISMATCH' | 'INVALID_REQUEST' | 'INVALID_PARAMS', public rpcCode: number, public data?: object) { super(reason, 400); }
}
const paramsSchema = z.looseObject({ _meta: z.record(z.string(), z.unknown()).optional() });
export const listParams = z.strictObject({ cursor: z.string().optional() });
export function protocolRequest(method: string, input: unknown, headers: Record<string, string | string[] | undefined>) {
  const params = paramsSchema.parse(input ?? {});
  const meta = params._meta;
  const header = headers['mcp-protocol-version'];
  const bodyVersion = meta?.['io.modelcontextprotocol/protocolVersion'];
  const version = header ?? bodyVersion ?? '2025-03-26';
  if (method !== 'initialize' && !(SUPPORTED_PROTOCOLS as readonly unknown[]).includes(version)) {
    throw new ProtocolFailure('UNSUPPORTED_VERSION', -32022, { supported: SUPPORTED_PROTOCOLS, requested: typeof version === 'string' ? version : '' });
  }
  const modern = method !== 'initialize' && version === PROTOCOL;
  if (modern) {
    if (header !== PROTOCOL || bodyVersion !== PROTOCOL || headers['mcp-method'] !== method) throw new ProtocolFailure('HEADER_MISMATCH', -32020);
    z.object({ name: z.string(), version: z.string() }).parse(meta?.['io.modelcontextprotocol/clientInfo']);
    z.record(z.string(), z.unknown()).parse(meta?.['io.modelcontextprotocol/clientCapabilities']);
    if (method === 'tools/call') {
      const name = headers['mcp-name'];
      const decoded = typeof name === 'string' && /^=\?base64\?[A-Za-z0-9+/]*={0,2}\?=$/.test(name) ? Buffer.from(name.slice(9, -2), 'base64').toString('utf8') : name;
      if (typeof decoded !== 'string' || decoded !== params.name) throw new ProtocolFailure('HEADER_MISMATCH', -32020);
    }
  } else if (header && bodyVersion && header !== bodyVersion) throw new ProtocolFailure('HEADER_MISMATCH', -32020);
  // Standard request metadata is transport information, never tool arguments or identity.
  const { _meta, ...clean } = params;
  return { modern, params: clean };
}
export function initializeVersion(params: unknown) {
  const { protocolVersion } = z.object({ protocolVersion: z.string() }).parse(params);
  // Legacy handshake clients cannot be switched into the handshake-free era.
  return (SUPPORTED_PROTOCOLS as readonly string[]).includes(protocolVersion) && protocolVersion !== PROTOCOL ? protocolVersion : '2025-11-25';
}
