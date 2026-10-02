import { createHash } from 'node:crypto';
import type { SendInput } from '../../contracts/src/index.js';
import type { State } from './model.js';

export const MODERATION_POLICY = 'stage-0a-moderation-v1';
export const BLOCK_LIMIT = 3;
export const REVIEW_TTL_MS = 10 * 60000;
export const FILTER_TIMEOUT_MS = 1000;
export const REVIEW_QUEUE_LIMIT = 5;
export type ModerationOutcome = 'allow' | 'block' | 'human_review' | 'filter_error';
// No real/external provider implementation is enabled in Stage 0A. Adding one
// requires a tested adapter and, for external services, the owner's approval.
export interface ModerationAdapter {
  source: 'mock' | 'human-only';
  evaluate(input: Readonly<SendInput>): Promise<unknown>;
}
export const humanOnlyModeration: ModerationAdapter = {
  source: 'human-only', async evaluate() { return 'human_review'; }
};
export async function evaluateModeration(adapter: ModerationAdapter, input: SendInput): Promise<ModerationOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      adapter.evaluate(Object.freeze({ ...input })),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Filter timeout')), FILTER_TIMEOUT_MS); })
    ]);
    if (!['allow', 'block', 'human_review', 'filter_error'].includes(result as string)) return 'filter_error';
    // A default/manual adapter cannot accidentally auto-approve a message.
    if (adapter.source === 'human-only' && result === 'allow') return 'filter_error';
    return result as ModerationOutcome;
  } catch { return 'filter_error'; }
  finally { clearTimeout(timer); }
}
export function moderationContext(s: State, roomId: string): string {
  const room = s.rooms.find(r => r.id === roomId)!;
  const sorted = <T>(items: T[]) => items.map(x => JSON.stringify(x)).sort();
  // Audience, rights, history visibility and selected brief are approval inputs.
  // Counters/room sequence are excluded; their current limits are checked at commit.
  const members = s.memberships.filter(m => m.roomId === roomId && m.active);
  const grants = s.grants.filter(g => g.roomId === roomId && g.active);
  const connections = s.connections.filter(c => grants.some(g => g.connectionId === c.id)).map(c => ({ id: c.id, ownerId: c.ownerId, active: c.active, suspended: Boolean(c.suspended), scopes: [...c.scopes].sort() }));
  return createHash('sha256').update(JSON.stringify({ policy: MODERATION_POLICY, room: roomId, owner: room.ownerId, brief: room.brief, session: { id: room.session.id, expiresAt: room.session.expiresAt, totalLimit: room.session.totalLimit, perConnectionLimit: room.session.perConnectionLimit, cooldownMs: room.session.cooldownMs, chainLimit: room.session.chainLimit, starter: room.session.starter }, members: sorted(members), grants: sorted(grants.map(g => ({ ...g, scopes: [...g.scopes].sort() }))), connections: sorted(connections) })).digest('hex');
}
export function pauseForModeration(s: State, roomId: string, reason: string, now: number) {
  const room = s.rooms.find(r => r.id === roomId)!;
  room.session.state = 'paused'; room.session.reason = reason;
  const ids = new Set(s.subscriptions.filter(x => x.roomId === roomId).map(x => x.id));
  s.outbox.filter(x => ids.has(x.subscriptionId) && x.state === 'queued').forEach(x => { x.state = 'cancelled'; });
  s.audit.push({ action: `moderation.pause.${reason}`, target: roomId, at: now });
}
export function suspendConnection(s: State, connectionId: string, now: number) {
  const c = s.connections.find(x => x.id === connectionId);
  if (!c) throw new Error('Unknown connection');
  c.suspended = true;
  const ids = new Set(s.subscriptions.filter(x => x.connectionId === connectionId).map(x => { x.active = false; return x.id; }));
  s.outbox.filter(x => ids.has(x.subscriptionId) && x.state === 'queued').forEach(x => { x.state = 'cancelled'; });
  s.audit.push({ action: 'moderation.connection_suspended', target: connectionId, at: now });
}
