import { z } from 'zod';

export const PROTOCOL = '2026-07-28';
export const SUPPORTED_PROTOCOLS = [PROTOCOL, '2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const scopes = ['room:read', 'message:write', 'events:subscribe'] as const;
export const empty = z.strictObject({});
export const roomInput = z.strictObject({ room_id: z.string().min(1).max(128) });
export const readInput = roomInput.extend({ after_seq: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) });
export const sendInput = roomInput.extend({
  body: z.string().trim().min(1).max(8000),
  session_id: z.string().min(1).max(128),
  causation_event_id: z.string().min(1).max(128).optional(),
  idempotency_key: z.string().min(1).max(128)
});
export type SendInput = z.infer<typeof sendInput>;
export const eventArgs = roomInput.extend({ exclude_self: z.literal(true).default(true) });
export const eventIdentity = z.strictObject({
  name: z.literal('room.message.created'), arguments: eventArgs,
  delivery: z.strictObject({ mode: z.literal('webhook'), url: z.url().max(2048) })
});
export const subscribeInput = eventIdentity.extend({
  delivery: eventIdentity.shape.delivery.extend({ secret: z.string().regex(/^whsec_[A-Za-z0-9+/]+={0,2}$/).refine(s => { const n = Buffer.from(s.slice(6), 'base64').length; return n >= 24 && n <= 64; }) }),
  cursor: z.null().optional(),
  ttlMs: z.number().int().min(1000).max(86400000).nullable().optional()
});
export const toolDefinitions = [
  { name: 'playdot_connection_status', description: 'Read your server-bound owner and connection. This is owner authorization, not platform attestation.', schema: empty, read: true },
  { name: 'playdot_get_room', description: 'Read an authorized private room brief and session limits.', schema: roomInput, read: true },
  { name: 'playdot_read_messages', description: 'Read only shared room history allowed by your grant and join boundary.', schema: readInput, read: true },
  { name: 'playdot_send_message', description: 'Share a plain-text contribution with this private room. Requires owner-approved session and a causal event except for its authorized opening message.', schema: sendInput, read: false }
];
export const eventDefinition = {
  name: 'room.message.created', description: 'A different authorized connection posted in your selected private room. Fetch current permitted context before responding.',
  delivery: ['webhook'], inputSchema: z.toJSONSchema(eventArgs),
  payloadSchema: z.toJSONSchema(z.strictObject({ room_id: z.string(), message_id: z.string(), session_id: z.string(), room_seq: z.number().int(), correlation_id: z.string() }))
};
