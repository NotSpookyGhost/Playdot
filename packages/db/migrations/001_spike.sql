-- Stage 0A only: one serialized aggregate keeps permissions, counters, messages,
-- subscriptions and outbox atomic with a small implementation. No capacity claim.
-- Replace with normalized, room-scoped tables in Stage 1.
CREATE TABLE IF NOT EXISTS playdot_spike_state (
  id integer PRIMARY KEY CHECK (id = 1),
  schema_version integer NOT NULL CHECK (schema_version = 1),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object')
);
