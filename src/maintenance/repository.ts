import { Pool } from "pg";

export type MaintenanceStatus = "Scheduled" | "In Progress" | "Resolved";
export type MaintenanceSeverity = "Advisory" | "Minor" | "Major" | "Critical";
export type MaintenanceDraft = {
  title: string;
  description: string;
  affectedArea: string;
  severity: MaintenanceSeverity;
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  restorationEstimate?: string;
};
export type MaintenanceIncident = MaintenanceDraft & {
  id: string;
  status: MaintenanceStatus;
  createdBy: string;
  updatedBy: string;
  createdAt: Date;
  updatedAt: Date;
};
export type MaintenanceDetail = {
  incident: MaintenanceIncident;
  auditHistory: Array<{
    actorId: string;
    action: string;
    previousStatus?: MaintenanceStatus;
    newStatus?: MaintenanceStatus;
    reason?: string;
    createdAt: Date;
  }>;
};

const statuses: readonly MaintenanceStatus[] = ["Scheduled", "In Progress", "Resolved"];
const severities: readonly MaintenanceSeverity[] = ["Advisory", "Minor", "Major", "Critical"];
export function validateMaintenanceDraft(draft: MaintenanceDraft): void {
  if (!draft.title.trim()) throw new Error("Maintenance title is required");
  if (!draft.description.trim()) throw new Error("Maintenance description is required");
  if (!draft.affectedArea.trim()) throw new Error("Affected area is required");
  if (!severities.includes(draft.severity)) throw new Error("Invalid maintenance severity");
  if (draft.plannedStartAt && Number.isNaN(draft.plannedStartAt.getTime())) throw new Error("Invalid planned start time");
  if (draft.plannedEndAt && Number.isNaN(draft.plannedEndAt.getTime())) throw new Error("Invalid planned end time");
  if (draft.plannedStartAt && draft.plannedEndAt && draft.plannedEndAt < draft.plannedStartAt) throw new Error("Planned end must be after planned start");
}

type Row = {
  id: string; title: string; description: string; affected_area: string;
  status: MaintenanceStatus; severity: MaintenanceSeverity;
  planned_start_at: Date | null; planned_end_at: Date | null;
  restoration_estimate: string | null; created_by: string; updated_by: string;
  created_at: Date; updated_at: Date;
};
function toIncident(row: Row): MaintenanceIncident {
  return {
    id: row.id, title: row.title, description: row.description, affectedArea: row.affected_area,
    status: row.status, severity: row.severity, createdBy: row.created_by, updatedBy: row.updated_by,
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.planned_start_at ? { plannedStartAt: row.planned_start_at } : {}),
    ...(row.planned_end_at ? { plannedEndAt: row.planned_end_at } : {}),
    ...(row.restoration_estimate ? { restorationEstimate: row.restoration_estimate } : {}),
  };
}

export type MaintenanceListQuery = { status?: MaintenanceStatus; affectedArea?: string; search?: string };
export class PostgresMaintenanceRepository {
  constructor(private readonly pool: Pool) {}
  async list(query: MaintenanceListQuery = {}): Promise<MaintenanceIncident[]> {
    const values: string[] = [];
    const clauses: string[] = [];
    if (query.status) { values.push(query.status); clauses.push(`status = $${values.length}`); }
    if (query.affectedArea) { values.push(`%${query.affectedArea}%`); clauses.push(`affected_area ILIKE $${values.length}`); }
    if (query.search) { values.push(`%${query.search}%`); const n = values.length; clauses.push(`(title ILIKE $${n} OR description ILIKE $${n} OR affected_area ILIKE $${n})`); }
    const result = await this.pool.query<Row>(`SELECT * FROM maintenance_incidents ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY CASE status WHEN 'In Progress' THEN 0 WHEN 'Scheduled' THEN 1 ELSE 2 END, updated_at DESC LIMIT 100`, values);
    return result.rows.map(toIncident);
  }
  async create(draft: MaintenanceDraft, actorId: string): Promise<MaintenanceIncident> {
    validateMaintenanceDraft(draft);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Row>(`INSERT INTO maintenance_incidents (title, description, affected_area, severity, planned_start_at, planned_end_at, restoration_estimate, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [draft.title.trim(), draft.description.trim(), draft.affectedArea.trim(), draft.severity, draft.plannedStartAt ?? null, draft.plannedEndAt ?? null, draft.restorationEstimate?.trim() || null, actorId]);
      const row = result.rows[0]; if (!row) throw new Error("Maintenance creation failed");
      await client.query("INSERT INTO maintenance_audit (incident_id, actor_id, action, new_status, reason) VALUES ($1,$2,'created',$3,$4)", [row.id, actorId, row.status, draft.description.trim()]);
      await client.query("COMMIT"); return toIncident(row);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async get(id: string): Promise<MaintenanceDetail | undefined> {
    const result = await this.pool.query<Row>("SELECT * FROM maintenance_incidents WHERE id = $1", [id]);
    const row = result.rows[0]; if (!row) return undefined;
    const audit = await this.pool.query("SELECT actor_id, action, previous_status, new_status, reason, created_at FROM maintenance_audit WHERE incident_id = $1 ORDER BY created_at DESC", [id]);
    return { incident: toIncident(row), auditHistory: audit.rows.map((entry) => ({ actorId: entry.actor_id, action: entry.action, ...(entry.previous_status ? { previousStatus: entry.previous_status } : {}), ...(entry.new_status ? { newStatus: entry.new_status } : {}), ...(entry.reason ? { reason: entry.reason } : {}), createdAt: entry.created_at })) };
  }
  async updateStatus(id: string, status: MaintenanceStatus, actorId: string, reason: string): Promise<MaintenanceDetail> {
    if (!statuses.includes(status)) throw new Error("Invalid maintenance status");
    if (!reason.trim()) throw new Error("A reason is required");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<Row>("SELECT * FROM maintenance_incidents WHERE id = $1 FOR UPDATE", [id]);
      const row = current.rows[0]; if (!row) throw new Error("Maintenance incident not found");
      if (row.status === status) throw new Error("Maintenance incident is already in that status");
      if (row.status === "Resolved") throw new Error("Resolved incidents cannot be reopened");
      const updated = await client.query<Row>("UPDATE maintenance_incidents SET status = $1, updated_by = $2, updated_at = NOW() WHERE id = $3 RETURNING *", [status, actorId, id]);
      const next = updated.rows[0]; if (!next) throw new Error("Maintenance update failed");
      await client.query("INSERT INTO maintenance_audit (incident_id, actor_id, action, previous_status, new_status, reason) VALUES ($1,$2,'status_changed',$3,$4,$5)", [id, actorId, row.status, status, reason.trim()]);
      await client.query("COMMIT");
      return (await this.get(id))!;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
