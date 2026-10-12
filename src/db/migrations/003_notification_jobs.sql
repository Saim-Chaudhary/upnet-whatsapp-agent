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
