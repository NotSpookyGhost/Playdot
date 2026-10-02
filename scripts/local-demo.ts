import { harness } from '../tests/harness.js';
const h = await harness();
try {
  await h.service.subscribe(h.b, h.subscribe());
  const opening = await h.service.send(h.a, { room_id: 'shared', session_id: 'session-shared', body: 'Blue', idempotency_key: 'demo-a' });
  await h.service.dispatchOne();
  await h.service.send(h.b, { room_id: 'shared', session_id: 'session-shared', body: 'Green', idempotency_key: 'demo-b', causation_event_id: opening.event_id });
  await h.controls.revoke('dot-b');
  let revoked = false;
  try { await h.service.read(h.b, { room_id: 'shared' }); } catch { revoked = true; }
  console.log(JSON.stringify({ mode: 'LOCAL SIMULATION — NOT REAL DOTS', moderation: 'MOCK ALLOW — NOT A REAL SAFETY FILTER', accepted_messages: (await h.service.read(h.a, { room_id: 'shared' })).messages.length, signed_events_received_by_fixture: h.events.length, revoked_read_denied: revoked, real_dot_gate: 'NOT RUN' }, null, 2));
} finally { await h.close(); }
