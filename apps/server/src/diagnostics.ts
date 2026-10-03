import { randomUUID } from 'node:crypto';

// Never accept arbitrary fields or serialize exceptions/request objects.
export const diagnosticReasons = {
  token: ['TOKEN_OK', 'BEARER_REQUIRED', 'TOKEN_AUDIENCE', 'TOKEN_ISSUER', 'TOKEN_EXPIRED', 'TOKEN_CLAIMS', 'TOKEN_SUBJECT_INVALID', 'TOKEN_CLIENT_INVALID', 'TOKEN_SCOPE_INVALID', 'TOKEN_CLIENT_AMBIGUOUS', 'TOKEN_IAT_INVALID', 'TOKEN_EXP_INVALID', 'TOKEN_NBF_INVALID', 'TOKEN_SIGNATURE', 'TOKEN_ALGORITHM', 'TOKEN_INVALID'],
  jwks: ['JWKS_TIMEOUT', 'JWKS_KEY_UNAVAILABLE', 'JWKS_FETCH_FAILED'],
  authorization: ['AUTHORIZED', 'CLIENT_DENIED', 'SCOPE_DENIED', 'CONNECTION_DENIED', 'AUTHORIZATION_DENIED'],
  protocol: ['INITIALIZE_OK', 'DISCOVER_OK', 'TOOLS_LIST_OK', 'RPC_OK', 'INITIALIZED', 'GET_NOT_SUPPORTED', 'UNSUPPORTED_VERSION', 'HEADER_MISMATCH', 'INVALID_REQUEST', 'INVALID_PARAMS', 'METHOD_NOT_FOUND', 'ORIGIN_DENIED', 'HTTP_PARSE_REJECTED', 'HTTP_CONTENT_TYPE_REJECTED', 'HTTP_JSON_INVALID', 'HTTP_BODY_EMPTY', 'HTTP_BODY_TOO_LARGE', 'OPERATION_DENIED'],
  internal: ['INTERNAL_FAILURE']
} as const;
export type Phase = keyof typeof diagnosticReasons;
export type Reason = typeof diagnosticReasons[Phase][number];
export type DiagnosticSink = (line: string) => void;
export function diagnostic(sink: DiagnosticSink = line => console.log(line)) {
  const correlationId = randomUUID();
  return { correlationId, emit(phase: Phase, reason: Reason) {
    if (!(diagnosticReasons[phase] as readonly string[] | undefined)?.includes(reason)) return;
    try { sink(JSON.stringify({ phase, reason, correlation_id: correlationId })); } catch { /* Logging cannot change authorization. */ }
  } };
}

// Operator log collector: reject extra fields and unknown values, then reserialize.
export function sanitizedDiagnostic(line: string): string | undefined {
  if (line.length > 512) return;
  try {
    const value = JSON.parse(line);
    if (!value || Object.keys(value).sort().join(',') !== 'correlation_id,phase,reason') return;
    if (typeof value.phase !== 'string' || typeof value.reason !== 'string') return;
    if (!Object.hasOwn(diagnosticReasons, value.phase) || !(diagnosticReasons[value.phase as Phase] as readonly string[]).includes(value.reason)) return;
    if (typeof value.correlation_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.correlation_id)) return;
    return JSON.stringify({ phase: value.phase, reason: value.reason, correlation_id: value.correlation_id });
  } catch { return; }
}
