CREATE TABLE schema_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL
);
INSERT INTO schema_metadata (singleton, schema_version) VALUES (1, 1);

CREATE TABLE canonical_events (
  global_position INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT,
  UNIQUE(stream_id, stream_version)
);
CREATE INDEX canonical_events_stream ON canonical_events(stream_id, stream_version);

CREATE TABLE processed_commands (
  idempotency_key TEXT PRIMARY KEY,
  stream_id TEXT NOT NULL,
  first_version INTEGER NOT NULL,
  last_version INTEGER NOT NULL
);

CREATE TABLE evidence_projection (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL
);
CREATE TABLE proposal_projection (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE assertion_projection (
  id TEXT PRIMARY KEY,
  privacy TEXT NOT NULL,
  status TEXT NOT NULL,
  valid_from_ms INTEGER NOT NULL,
  valid_until_ms INTEGER,
  search_text TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX assertion_projection_temporal
  ON assertion_projection(status, valid_from_ms, valid_until_ms);
CREATE TABLE decision_projection (
  id TEXT PRIMARY KEY,
  privacy TEXT NOT NULL,
  decided_at_ms INTEGER NOT NULL,
  search_text TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE INDEX decision_projection_temporal ON decision_projection(decided_at_ms);
CREATE TABLE audit_projection (
  event_id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL
);

CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_version TEXT NOT NULL,
  context_ids_json TEXT NOT NULL,
  tool_calls_json TEXT NOT NULL,
  latency_ms REAL NOT NULL,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  estimated_usd REAL,
  output TEXT,
  eval_result TEXT,
  error TEXT
);
