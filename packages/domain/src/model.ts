export type Scope = 'room:read' | 'message:write' | 'events:subscribe';
export type Principal = { issuer: string; subject: string; clientId: string; scopes: string[]; expiresAt: number };
export type Connection = { id: string; ownerId: string; issuer: string; subject: string; clientId: string; active: boolean; scopes: Scope[]; suspended?: boolean; blockCount?: number };
export type Membership = { ownerId: string; roomId: string; role: 'member' | 'spectator'; active: boolean; historyFrom: number };
export type Grant = { connectionId: string; roomId: string; active: boolean; scopes: Scope[] };
export type Session = { id: string; state: 'active' | 'paused'; reason?: string; expiresAt: number; totalLimit: number; perConnectionLimit: number; cooldownMs: number; chainLimit: number; starter: string; total: number; counts: Record<string, number>; lastAt: Record<string, number>; claims: string[] };
export type Room = { id: string; ownerId: string; brief: string; seq: number; session: Session };
export type ModerationDecision = { id: string; connectionId: string; roomId: string; key: string; hash: string; contextHash: string; policyVersion: string; source: 'mock' | 'human-only'; outcome: 'allow' | 'block' | 'human_review' | 'filter_error' | 'approved' | 'rejected'; createdAt: number; expiresAt: number; encryptedInput?: string; reviewedBy?: string };
export type Message = { id: string; room_id: string; room_seq: number; body: string; author_connection_id: string; owner_user_id: string; session_id: string; event_id: string; causation_event_id?: string; correlation_id: string; depth: number; occurred_at: string; moderation: { approved: true; decisionId: string; source: 'mock' | 'human'; policyVersion: string } };
export type Subscription = { id: string; connectionId: string; roomId: string; url: string; secret: string; oldSecret?: string; rotationUntil?: number; expiresAt: number; tokenExpiresAt: number; active: boolean };
export type Delivery = { id: string; eventId: string; subscriptionId: string; state: 'queued' | 'received' | 'failed' | 'cancelled'; attempts: number; nextAt: number; repliedMessageId?: string };
export type State = {
  connections: Connection[]; memberships: Membership[]; grants: Grant[]; rooms: Room[]; messages: Message[];
  subscriptions: Subscription[]; outbox: Delivery[]; moderation: ModerationDecision[];
  idempotency: { connectionId: string; key: string; hash: string; messageId: string }[];
  invitations: { hash: string; roomId: string; expiresAt: number; used: boolean; role: 'member' | 'spectator' }[];
  audit: { action: string; target: string; at: number }[];
};
export const emptyState = (): State => ({ connections: [], memberships: [], grants: [], rooms: [], messages: [], subscriptions: [], outbox: [], moderation: [], idempotency: [], invitations: [], audit: [] });
export interface Store { transact<T>(fn: (state: State) => T | Promise<T>): Promise<T>; close(): Promise<void> }
export class Fault extends Error {
  constructor(public code: string, public status = 403, public details?: { moderation_id: string; moderation_source: 'mock' | 'human-only'; outcome: string }) { super(code); }
}
