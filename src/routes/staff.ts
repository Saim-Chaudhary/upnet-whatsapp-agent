import { FastifyInstance } from "fastify";
import { getDatabasePool } from "../db/pool.js";
import { AuthenticatedSession, StaffAuthService, clearSessionCookie, setSessionCookie } from "../staff/auth.js";
import { InMemoryTicketRepository, PostgresTicketRepository, TicketRepository, TicketStatus } from "../tickets/repository.js";
import { PostgresNotificationJobStore } from "../notifications/jobs.js";
import { MaintenanceDraft, MaintenanceStatus, PostgresMaintenanceRepository } from "../maintenance/repository.js";

function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "Ticket not found") return { status: 404, error: message };
  if (message === "Ticket conflict") return { status: 409, error: "Ticket was changed by another user" };
  if (message === "Invalid credentials" || message === "Login temporarily unavailable") return { status: 401, error: message };
  return { status: 400, error: "Request could not be completed" };
}

export type StaffAuthLike = {
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedSession | undefined>;
  login(email: string, password: string, ip?: string): Promise<{ token: string; csrfToken: string; actor: AuthenticatedSession["actor"] }>;
  logout(headers: Record<string, string | string[] | undefined>): Promise<void>;
};
type NotificationMonitor = {
  list(status?: "pending" | "processing" | "sent" | "failed"): ReturnType<PostgresNotificationJobStore["list"]>;
  retry(id: string): Promise<boolean>;
};
type MaintenanceMonitor = {
  list(query?: { status?: MaintenanceStatus; affectedArea?: string; search?: string }): ReturnType<PostgresMaintenanceRepository["list"]>;
  create(draft: MaintenanceDraft, actorId: string): ReturnType<PostgresMaintenanceRepository["create"]>;
  get(id: string): ReturnType<PostgresMaintenanceRepository["get"]>;
  updateStatus(id: string, status: MaintenanceStatus, actorId: string, reason: string): ReturnType<PostgresMaintenanceRepository["updateStatus"]>;
};
export default async function staffRoutes(app: FastifyInstance, options: { tickets?: TicketRepository; auth?: StaffAuthLike; notifications?: NotificationMonitor; maintenance?: MaintenanceMonitor } = {}) {
  const pool = options.auth ? undefined : getDatabasePool();
  const auth: StaffAuthLike = options.auth ?? new StaffAuthService(pool!);
  const tickets = options.tickets ?? new PostgresTicketRepository(pool!);
  const notifications = options.notifications ?? (pool ? new PostgresNotificationJobStore(pool) : undefined);
  const maintenance = options.maintenance ?? (pool ? new PostgresMaintenanceRepository(pool) : undefined);
  const session = async (request: any, reply: any, csrf = false) => {
    const current = await auth.authenticate(request.headers);
    if (!current) { reply.code(401).send({ error: "Authentication required" }); return undefined; }
    if (csrf) {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${request.headers.host}` && origin !== `https://${request.headers.host}`) {
        reply.code(403).send({ error: "Same-origin validation failed" }); return undefined;
      }
      if (request.headers["x-csrf-token"] !== current.csrfToken) { reply.code(403).send({ error: "CSRF validation failed" }); return undefined; }
    }
    return current;
  };
  app.post<{ Body: { email?: unknown; password?: unknown } }>("/api/staff/login", async (request, reply) => {
    if (typeof request.body?.email !== "string" || typeof request.body?.password !== "string") return reply.code(400).send({ error: "Email and password are required" });
    try {
      const result = await auth.login(request.body.email, request.body.password, request.ip);
      setSessionCookie(reply, result.token);
      return { actor: result.actor, csrfToken: result.csrfToken };
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.post("/api/staff/logout", async (request, reply) => {
    try {
      const current = await session(request, reply, true); if (!current) return;
      await auth.logout(request.headers); clearSessionCookie(reply); return { ok: true };
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.get("/api/staff/me", async (request, reply) => {
    try {
      const current = await session(request, reply); if (!current) return;
      return { actor: current.actor, csrfToken: current.csrfToken };
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.get("/api/staff/overview", async (request, reply) => {
    try {
      if (!await session(request, reply)) return;
      if (!pool) return reply.code(501).send({ error: "Overview unavailable" });
      const result = await pool.query<{
        open: string; in_progress: string; urgent: string; resolved_today: string;
      }>(`SELECT
        count(*) FILTER (WHERE status = 'Open')::int AS open,
        count(*) FILTER (WHERE status = 'In Progress')::int AS in_progress,
        count(*) FILTER (WHERE priority = 'Urgent' AND status <> 'Resolved')::int AS urgent,
        count(*) FILTER (WHERE status = 'Resolved' AND updated_at >= CURRENT_DATE)::int AS resolved_today
        FROM support_tickets`);
      const recent = await pool.query(`SELECT ticket_number, customer_name, problem_description, status, priority, updated_at
        FROM support_tickets ORDER BY updated_at DESC LIMIT 5`);
      const notificationCounts = await pool.query<{ status: string; count: string }>(
        "SELECT status, count(*)::int FROM notification_jobs GROUP BY status",
      );
      const maintenanceCounts = await pool.query<{ status: string; count: string }>(
        "SELECT status, count(*)::int FROM maintenance_incidents GROUP BY status",
      );
      const incidentCounts = Object.fromEntries(maintenanceCounts.rows.map((row) => [row.status, Number(row.count)]));
      const counts = Object.fromEntries(notificationCounts.rows.map((row) => [row.status, Number(row.count)]));
      return {
        tickets: {
          open: Number(result.rows[0]?.open ?? 0),
          inProgress: Number(result.rows[0]?.in_progress ?? 0),
          urgent: Number(result.rows[0]?.urgent ?? 0),
          resolvedToday: Number(result.rows[0]?.resolved_today ?? 0),
        },
        notifications: {
          pending: counts.pending ?? 0,
          failed: counts.failed ?? 0,
          sent: counts.sent ?? 0,
        },
        maintenance: {
          active: incidentCounts["In Progress"] ?? 0,
          scheduled: incidentCounts.Scheduled ?? 0,
        },
        recent: recent.rows,
      };
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.get<{ Querystring: { status?: string } }>("/api/staff/notifications", async (request, reply) => {
    try {
      if (!await session(request, reply)) return;
      if (!notifications) return reply.code(501).send({ error: "Notification monitoring unavailable" });
      const status = request.query.status;
      if (status && !["pending", "processing", "sent", "failed"].includes(status)) return reply.code(400).send({ error: "Invalid notification status" });
      const jobs = await notifications.list(status as "pending" | "processing" | "sent" | "failed" | undefined);
      return jobs.map(({ recipient, text: _text, ...job }) => ({
        ...job,
        recipient: recipient.replace(/(\d{3})\d+(\d{3}@)/, "$1••••$2"),
      }));
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.post<{ Params: { id: string } }>("/api/staff/notifications/:id/retry", async (request, reply) => {
    const current = await session(request, reply, true); if (!current) return;
    try {
      if (!notifications) return reply.code(501).send({ error: "Notification retry unavailable" });
      const retried = await notifications.retry(request.params.id);
      if (!retried) return reply.code(409).send({ error: "Only failed notifications can be retried" });
      return { ok: true };
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.get<{ Querystring: { status?: string; affectedArea?: string; search?: string } }>("/api/staff/maintenance", async (request, reply) => {
    try {
      if (!await session(request, reply)) return;
      if (!maintenance) return reply.code(501).send({ error: "Maintenance monitoring unavailable" });
      const { status, affectedArea, search } = request.query;
      if (status && !["Scheduled", "In Progress", "Resolved"].includes(status)) return reply.code(400).send({ error: "Invalid maintenance status" });
      return await maintenance.list({ ...(status ? { status: status as MaintenanceStatus } : {}), ...(affectedArea ? { affectedArea } : {}), ...(search ? { search } : {}) });
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.get<{ Params: { id: string } }>("/api/staff/maintenance/:id", async (request, reply) => {
    try {
      if (!await session(request, reply)) return;
      if (!maintenance) return reply.code(501).send({ error: "Maintenance details unavailable" });
      const detail = await maintenance.get(request.params.id);
      if (!detail) return reply.code(404).send({ error: "Maintenance incident not found" });
      return detail;
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.post<{ Body: Partial<MaintenanceDraft> }>("/api/staff/maintenance", async (request, reply) => {
    const current = await session(request, reply, true); if (!current) return;
    try {
      if (!maintenance) return reply.code(501).send({ error: "Maintenance creation unavailable" });
      const body = request.body ?? {};
      if (typeof body.title !== "string" || typeof body.description !== "string" || typeof body.affectedArea !== "string" || !body.severity) return reply.code(400).send({ error: "Title, description, affected area, and severity are required" });
      const parseDate = (value: unknown) => value === undefined || value === "" ? undefined : new Date(String(value));
      const draft: MaintenanceDraft = { title: body.title, description: body.description, affectedArea: body.affectedArea, severity: body.severity };
      const plannedStartAt = parseDate(body.plannedStartAt);
      const plannedEndAt = parseDate(body.plannedEndAt);
      if (plannedStartAt) draft.plannedStartAt = plannedStartAt;
      if (plannedEndAt) draft.plannedEndAt = plannedEndAt;
      if (body.restorationEstimate) draft.restorationEstimate = String(body.restorationEstimate);
      return reply.code(201).send(await maintenance.create(draft, current.actor.id));
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.patch<{ Params: { id: string }; Body: { status?: MaintenanceStatus; reason?: string } }>("/api/staff/maintenance/:id/status", async (request, reply) => {
    const current = await session(request, reply, true); if (!current) return;
    try {
      if (!maintenance) return reply.code(501).send({ error: "Maintenance updates unavailable" });
      if (!request.body?.status || !["Scheduled", "In Progress", "Resolved"].includes(request.body.status) || typeof request.body.reason !== "string") return reply.code(400).send({ error: "A valid status and reason are required" });
      return await maintenance.updateStatus(request.params.id, request.body.status, current.actor.id, request.body.reason);
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.get<{ Querystring: { page?: string; pageSize?: string; search?: string; status?: TicketStatus; priority?: "Normal" | "High" | "Urgent"; dateFrom?: string; dateTo?: string; sort?: "createdAt" | "updatedAt" | "priority"; direction?: "asc" | "desc" } }>("/api/staff/tickets", async (request, reply) => {
    try {
      if (!await session(request, reply)) return;
      if (!tickets.listTickets) return reply.code(501).send({ error: "Ticket listing unavailable" });
      return tickets.listTickets({ ...request.query, page: Number(request.query.page) || 1, pageSize: Number(request.query.pageSize) || 25 });
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.get<{ Params: { ticketNumber: string } }>("/api/staff/tickets/:ticketNumber", async (request, reply) => {
    try {
      if (!await session(request, reply)) return;
      if (!tickets.getTicketDetail) return reply.code(501).send({ error: "Ticket details unavailable" });
      const detail = await tickets.getTicketDetail(request.params.ticketNumber);
      if (!detail) return reply.code(404).send({ error: "Ticket not found" });
      return detail;
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
  app.patch<{ Params: { ticketNumber: string }; Body: { status?: TicketStatus; priority?: "Normal" | "High" | "Urgent"; reason?: string; expectedUpdatedAt?: string } }>("/api/staff/tickets/:ticketNumber", async (request, reply) => {
    const current = await session(request, reply, true); if (!current) return;
    if (!request.body?.expectedUpdatedAt) return reply.code(400).send({ error: "expectedUpdatedAt is required" });
    try {
      if (!tickets.updateTicket) return reply.code(501).send({ error: "Ticket updates unavailable" });
      const changes: { status?: TicketStatus; priority?: "Normal" | "High" | "Urgent"; reason?: string; expectedUpdatedAt: Date; actorId: string } = { expectedUpdatedAt: new Date(request.body.expectedUpdatedAt), actorId: current.actor.id };
      if (request.body.status) changes.status = request.body.status;
      if (request.body.priority) changes.priority = request.body.priority;
      if (request.body.reason) changes.reason = request.body.reason;
      return await tickets.updateTicket(request.params.ticketNumber, changes);
    } catch (error) { const safe = safeError(error); return reply.code(safe.status).send({ error: safe.error }); }
  });
}
