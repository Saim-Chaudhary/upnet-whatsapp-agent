CREATE SEQUENCE IF NOT EXISTS upnet_ticket_number_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGSERIAL PRIMARY KEY,
  ticket_number TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  customer_name TEXT,
  customer_phone TEXT NOT NULL,
  installation_address TEXT,
  problem_description TEXT NOT NULL,
  router_light_status TEXT,
  troubleshooting_steps TEXT NOT NULL,
  billing_check_result TEXT,
  priority TEXT NOT NULL CHECK (priority IN ('Normal', 'High', 'Urgent')),
  priority_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open'
    CHECK (status IN ('Open', 'In Progress', 'Resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_priority_audit (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  previous_priority TEXT NOT NULL CHECK (previous_priority IN ('Normal', 'High', 'Urgent')),
  new_priority TEXT NOT NULL CHECK (new_priority IN ('Normal', 'High', 'Urgent')),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ticket_audit (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  previous_priority TEXT,
  new_priority TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_users (
  id UUID PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('agent', 'admin')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS staff_sessions (
  id UUID PRIMARY KEY,
  staff_user_id UUID NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS staff_sessions_expiry_idx ON staff_sessions (expires_at);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id UUID PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  recipient TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ticket_created', 'ticket_resolved')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS notification_jobs_ready_idx
  ON notification_jobs (status, available_at, created_at);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL DEFAULT 'initial'
    CHECK (stage IN (
      'initial', 'router_check', 'restart_router', 'internet_status',
      'billing_check', 'payment_proof', 'ready_for_ticket', 'resolved',
      'payment_required'
    )),
  pending_ticket_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_locks (
  conversation_id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(conversation_id)
    ON DELETE CASCADE,
  sequence_number INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('human', 'ai', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, sequence_number)
);

CREATE TABLE IF NOT EXISTS inbound_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'completed', 'failed')),
  response JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
