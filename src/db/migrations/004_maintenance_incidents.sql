CREATE TABLE IF NOT EXISTS maintenance_incidents (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  affected_area TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Scheduled'
    CHECK (status IN ('Scheduled', 'In Progress', 'Resolved')),
  severity TEXT NOT NULL DEFAULT 'Advisory'
    CHECK (severity IN ('Advisory', 'Minor', 'Major', 'Critical')),
  planned_start_at TIMESTAMPTZ,
  planned_end_at TIMESTAMPTZ,
  restoration_estimate TEXT,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (planned_end_at IS NULL OR planned_start_at IS NULL OR planned_end_at >= planned_start_at)
);
CREATE INDEX IF NOT EXISTS maintenance_incidents_status_idx
  ON maintenance_incidents (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_incidents_area_idx
  ON maintenance_incidents (affected_area);

CREATE TABLE IF NOT EXISTS maintenance_audit (
  id BIGSERIAL PRIMARY KEY,
  incident_id BIGINT NOT NULL REFERENCES maintenance_incidents(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS maintenance_audit_incident_idx
  ON maintenance_audit (incident_id, created_at DESC);
