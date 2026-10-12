import { Pool } from "pg";
import { Priority } from "../agent/priority.js";
import { getDatabasePool } from "../db/pool.js";
import { enqueueNotification, whatsappChatId } from "../notifications/jobs.js";

export type TicketStatus = "Open" | "In Progress" | "Resolved";

export type TicketDraft = {
  idempotencyKey: string;
  customerName?: string;
  customerPhone: string;
  installationAddress?: string;
  problemDescription: string;
  routerLightStatus?: string;
  troubleshootingSteps: string;
  billingCheckResult?: string;
  priority: Priority;
  priorityReason: string;
};

export type Ticket = TicketDraft & {
  id: string;
  ticketNumber: string;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
};

export type PriorityOverrideActor = {
  actorId: string;
  role: "staff" | "admin";
};

export type PriorityAudit = {
  previousPriority: Priority;
  newPriority: Priority;
  reason: string;
  actorId: string;
  createdAt: Date;
};
export type TicketListQuery = { page?: number; pageSize?: number; search?: string; status?: TicketStatus; priority?: Priority; dateFrom?: string; dateTo?: string; sort?: "createdAt" | "updatedAt" | "priority"; direction?: "asc" | "desc" };
export type TicketListResult = { tickets: Ticket[]; page: number; pageSize: number; total: number };
export type TicketDetail = { ticket: Ticket; customerHistory: Ticket[]; auditHistory: Array<PriorityAudit & { action?: string; status?: TicketStatus }> };

export interface TicketRepository {
  createTicket(draft: TicketDraft): Promise<Ticket>;
  overridePriority(
    ticketNumber: string,
    priority: Priority,
    reason: string,
    actor: PriorityOverrideActor,
  ): Promise<{ ticket: Ticket; audit: PriorityAudit }>;
  listTickets?(query?: TicketListQuery): Promise<TicketListResult>;
  getTicketDetail?(ticketNumber: string): Promise<TicketDetail | undefined>;
  updateTicket?(ticketNumber: string, changes: { status?: TicketStatus; priority?: Priority; reason?: string; expectedUpdatedAt: Date; actorId: string }): Promise<TicketDetail>;
}

export function validateTicketDraft(draft: TicketDraft): void {
  if (!draft.idempotencyKey.trim()) {
    throw new Error("Ticket idempotency key is required");
  }
  if (!draft.customerPhone.trim()) {
    throw new Error("Customer phone number is required");
  }
  if (!draft.problemDescription.trim()) {
    throw new Error("Problem description is required");
  }
  if (!draft.troubleshootingSteps.trim()) {
    throw new Error("Troubleshooting steps are required");
  }
  if (!draft.priorityReason.trim()) {
    throw new Error("Priority reason is required");
  }
}

type TicketRow = {
  id: string;
  ticket_number: string;
  idempotency_key: string;
  customer_name: string | null;
  customer_phone: string;
  installation_address: string | null;
  problem_description: string;
  router_light_status: string | null;
  troubleshooting_steps: string;
  billing_check_result: string | null;
  priority: Priority;
  priority_reason: string;
  status: TicketStatus;
  created_at: Date;
  updated_at: Date;
};

function toTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    idempotencyKey: row.idempotency_key,
    customerPhone: row.customer_phone,
    problemDescription: row.problem_description,
    troubleshootingSteps: row.troubleshooting_steps,
    priority: row.priority,
    priorityReason: row.priority_reason,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.customer_name !== null
      ? { customerName: row.customer_name }
      : {}),
    ...(row.installation_address !== null
      ? { installationAddress: row.installation_address }
      : {}),
    ...(row.router_light_status !== null
      ? { routerLightStatus: row.router_light_status }
      : {}),
    ...(row.billing_check_result !== null
      ? { billingCheckResult: row.billing_check_result }
      : {}),
  };
}

export class PostgresTicketRepository implements TicketRepository {
  constructor(
    private readonly pool: Pool,
    private readonly adminWhatsAppNumber = process.env.ADMIN_WHATSAPP_NUMBER,
  ) {}

  async createTicket(draft: TicketDraft): Promise<Ticket> {
    validateTicketDraft(draft);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<TicketRow>(
        `INSERT INTO support_tickets (
          ticket_number, idempotency_key, customer_name, customer_phone,
          installation_address, problem_description, router_light_status,
          troubleshooting_steps, billing_check_result, priority, priority_reason
        )
        VALUES (
          'UP-' || nextval('upnet_ticket_number_seq'), $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10
        )
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING *`,
        [
          draft.idempotencyKey,
          draft.customerName ?? null,
          draft.customerPhone,
          draft.installationAddress ?? null,
          draft.problemDescription,
          draft.routerLightStatus ?? null,
          draft.troubleshootingSteps,
          draft.billingCheckResult ?? null,
          draft.priority,
          draft.priorityReason,
        ],
      );

      const row =
        inserted.rows[0] ??
        (
          await client.query<TicketRow>(
            "SELECT * FROM support_tickets WHERE idempotency_key = $1",
            [draft.idempotencyKey],
          )
        ).rows[0];
      if (!row) {
        throw new Error("Ticket insert did not return a ticket");
      }
      if (this.adminWhatsAppNumber) {
        await enqueueNotification(client, {
          dedupeKey: `ticket-created:${row.id}`,
          recipient: whatsappChatId(this.adminWhatsAppNumber),
          kind: "ticket_created",
          text: `New UpNet ticket ${row.ticket_number}: ${row.problem_description}`,
        });
      }

      await client.query("COMMIT");
      return toTicket(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async overridePriority(
    ticketNumber: string,
    priority: Priority,
    reason: string,
    actor: PriorityOverrideActor,
  ): Promise<{ ticket: Ticket; audit: PriorityAudit }> {
    if (actor.role !== "staff" && actor.role !== "admin") {
      throw new Error("Staff authorization is required");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<TicketRow>(
        "SELECT * FROM support_tickets WHERE ticket_number = $1 FOR UPDATE",
        [ticketNumber],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("Ticket not found");
      }

      const updated = await client.query<TicketRow>(
        `UPDATE support_tickets
         SET priority = $1, priority_reason = $2, updated_at = NOW()
         WHERE ticket_number = $3
         RETURNING *`,
        [priority, reason, ticketNumber],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new Error("Ticket priority update failed");
      }
      const audit = await client.query<{
        previous_priority: Priority;
        new_priority: Priority;
        reason: string;
        actor_id: string;
        created_at: Date;
      }>(
        `INSERT INTO ticket_priority_audit
          (ticket_id, previous_priority, new_priority, reason, actor_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING previous_priority, new_priority, reason, actor_id, created_at`,
        [row.id, row.priority, priority, reason, actor.actorId],
      );
      const auditRow = audit.rows[0];
      if (!auditRow) {
        throw new Error("Priority audit insert failed");
      }

      await client.query("COMMIT");
      return {
        ticket: toTicket(updatedRow),
        audit: {
          previousPriority: auditRow.previous_priority,
          newPriority: auditRow.new_priority,
          reason: auditRow.reason,
          actorId: auditRow.actor_id,
          createdAt: auditRow.created_at,
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listTickets(query: TicketListQuery = {}): Promise<TicketListResult> {
      const page = Math.max(1, query.page ?? 1), pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
      const values: unknown[] = []; const where: string[] = [];
      const add = (value: unknown) => { values.push(value); return `$${values.length}`; };
      if (query.search?.trim()) { const p = add(`%${query.search.trim()}%`); where.push(`(ticket_number ILIKE ${p} OR customer_name ILIKE ${p} OR customer_phone ILIKE ${p} OR problem_description ILIKE ${p})`); }
      if (query.status) where.push(`status = ${add(query.status)}`);
      if (query.priority) where.push(`priority = ${add(query.priority)}`);
      if (query.dateFrom) where.push(`created_at >= ${add(query.dateFrom)}`);
      if (query.dateTo) where.push(`created_at < ${add(query.dateTo)}`);
      const order = query.sort === "priority" ? "priority" : query.sort === "updatedAt" ? "updated_at" : "created_at";
      const direction = query.direction === "asc" ? "ASC" : "DESC";
      const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const count = await this.pool.query<{ count: string }>(`SELECT count(*) count FROM support_tickets ${filter}`, values);
      const offset = add((page - 1) * pageSize), limit = add(pageSize);
      const rows = await this.pool.query<TicketRow>(`SELECT * FROM support_tickets ${filter} ORDER BY ${order} ${direction}, id DESC LIMIT ${limit} OFFSET ${offset}`, values);
      return { tickets: rows.rows.map(toTicket), page, pageSize, total: Number(count.rows[0]?.count ?? 0) };
    }

    async getTicketDetail(ticketNumber: string): Promise<TicketDetail | undefined> {
      const result = await this.pool.query<TicketRow>("SELECT * FROM support_tickets WHERE ticket_number=$1", [ticketNumber]);
      const row = result.rows[0]; if (!row) return undefined;
      const ticket = toTicket(row);
      const history = await this.pool.query<TicketRow>("SELECT * FROM support_tickets WHERE customer_phone=$1 ORDER BY created_at DESC", [row.customer_phone]);
      const audits = await this.pool.query<{ previous_priority: Priority; new_priority: Priority; reason: string; actor_id: string; created_at: Date; action: string; new_status: TicketStatus | null }>(
        `SELECT a.previous_priority,a.new_priority,a.reason,a.actor_id,a.created_at,'priority' action,NULL new_status FROM ticket_priority_audit a JOIN support_tickets t ON t.id=a.ticket_id WHERE t.ticket_number=$1
         UNION ALL SELECT COALESCE(a.previous_priority,'Normal'),COALESCE(a.new_priority,'Normal'),a.reason,a.actor_id,a.created_at,a.action,a.new_status FROM ticket_audit a WHERE a.ticket_id=$2 ORDER BY created_at DESC`,
        [ticketNumber, row.id],
      );
      return { ticket, customerHistory: history.rows.map(toTicket), auditHistory: audits.rows.map((a) => ({ previousPriority: a.previous_priority, newPriority: a.new_priority, reason: a.reason ?? "", actorId: a.actor_id, createdAt: a.created_at, action: a.action, ...(a.new_status ? { status: a.new_status } : {}) })) };
    }

    async updateTicket(ticketNumber: string, changes: { status?: TicketStatus; priority?: Priority; reason?: string; expectedUpdatedAt: Date; actorId: string }): Promise<TicketDetail> {
      if (!changes.status && !changes.priority) throw new Error("No ticket changes supplied");
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        const old = (await client.query<TicketRow>("SELECT * FROM support_tickets WHERE ticket_number=$1 FOR UPDATE", [ticketNumber])).rows[0];
        if (!old) throw new Error("Ticket not found");
        const updated = await client.query<TicketRow>(
          `UPDATE support_tickets SET status=COALESCE($1,status), priority=COALESCE($2,priority), priority_reason=COALESCE($3,priority_reason), updated_at=NOW()
           WHERE ticket_number=$4
             AND updated_at >= $5
             AND updated_at < $5 + INTERVAL '1 millisecond'
           RETURNING *`,
          [changes.status ?? null, changes.priority ?? null, changes.reason ?? null, ticketNumber, changes.expectedUpdatedAt],
        );
        const row = updated.rows[0]; if (!row) throw new Error("Ticket conflict");
        await client.query(`INSERT INTO ticket_audit (ticket_id,actor_id,action,previous_status,new_status,previous_priority,new_priority,reason) VALUES ($1,$2,'update',$3,$4,$5,$6,$7)`,
          [row.id, changes.actorId, old.status, row.status, old.priority, row.priority, changes.reason ?? null]);
        if (old.status !== "Resolved" && row.status === "Resolved") {
          await enqueueNotification(client, {
            dedupeKey: `ticket-resolved:${row.id}:${row.updated_at.toISOString()}`,
            recipient: whatsappChatId(row.customer_phone),
            kind: "ticket_resolved",
            text: `UpNet ticket ${row.ticket_number} has been marked resolved. Reply if you still need help.`,
          });
        }
        await client.query("COMMIT");
        const detail = await this.getTicketDetail(ticketNumber); if (!detail) throw new Error("Ticket not found"); return detail;
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
    }
  }

export class InMemoryTicketRepository implements TicketRepository {
  private readonly tickets = new Map<string, Ticket>();
  private readonly audits = new Map<string, PriorityAudit[]>();
  private nextNumber = 1001;

  async createTicket(draft: TicketDraft): Promise<Ticket> {
    validateTicketDraft(draft);
    const existing = this.tickets.get(draft.idempotencyKey);
    if (existing) {
      return existing;
    }

    const now = new Date();
    const ticket: Ticket = {
      ...draft,
      id: String(this.tickets.size + 1),
      ticketNumber: `UP-${this.nextNumber++}`,
      status: "Open",
      createdAt: now,
      updatedAt: now,
    };
    this.tickets.set(draft.idempotencyKey, ticket);
    return ticket;
  }

  async overridePriority(
    ticketNumber: string,
    priority: Priority,
    reason: string,
    actor: PriorityOverrideActor,
  ): Promise<{ ticket: Ticket; audit: PriorityAudit }> {
    if (actor.role !== "staff" && actor.role !== "admin") {
      throw new Error("Staff authorization is required");
    }
    const ticket = [...this.tickets.values()].find(
      (candidate) => candidate.ticketNumber === ticketNumber,
    );
    if (!ticket) {
      throw new Error("Ticket not found");
    }
    const now = new Date();
    const audit = {
      previousPriority: ticket.priority,
      newPriority: priority,
      reason,
      actorId: actor.actorId,
      createdAt: now,
    };
    ticket.priority = priority;
    ticket.priorityReason = reason;
    ticket.updatedAt = now;
    this.audits.set(ticketNumber, [
      ...(this.audits.get(ticketNumber) ?? []),
      audit,
    ]);
    return { ticket, audit };
  }

  getAudits(ticketNumber: string): PriorityAudit[] {
    return [...(this.audits.get(ticketNumber) ?? [])];
  }

  async listTickets(query: TicketListQuery = {}): Promise<TicketListResult> {
    let tickets = [...this.tickets.values()];
    if (query.search) { const s = query.search.toLowerCase(); tickets = tickets.filter((t) => `${t.ticketNumber} ${t.customerName ?? ""} ${t.customerPhone} ${t.problemDescription}`.toLowerCase().includes(s)); }
    if (query.status) tickets = tickets.filter((t) => t.status === query.status);
    if (query.priority) tickets = tickets.filter((t) => t.priority === query.priority);
    tickets.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const page = Math.max(1, query.page ?? 1), pageSize = query.pageSize ?? 25;
    return { tickets: tickets.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: tickets.length };
  }
  async getTicketDetail(ticketNumber: string): Promise<TicketDetail | undefined> {
    const ticket = [...this.tickets.values()].find((t) => t.ticketNumber === ticketNumber); if (!ticket) return undefined;
    return { ticket, customerHistory: [...this.tickets.values()].filter((t) => t.customerPhone === ticket.customerPhone), auditHistory: this.getAudits(ticketNumber) };
  }
  async updateTicket(ticketNumber: string, changes: { status?: TicketStatus; priority?: Priority; reason?: string; expectedUpdatedAt: Date; actorId: string }): Promise<TicketDetail> {
    const ticket = [...this.tickets.values()].find((t) => t.ticketNumber === ticketNumber);
    if (!ticket) throw new Error("Ticket not found");
    if (ticket.updatedAt.getTime() !== changes.expectedUpdatedAt.getTime()) throw new Error("Ticket conflict");
    const oldPriority = ticket.priority; if (changes.status) ticket.status = changes.status; if (changes.priority) ticket.priority = changes.priority; if (changes.reason) ticket.priorityReason = changes.reason; ticket.updatedAt = new Date();
    if (changes.priority && changes.priority !== oldPriority) {
      const audits = this.audits.get(ticketNumber) ?? [];
      audits.push({ previousPriority: oldPriority, newPriority: changes.priority, reason: changes.reason ?? "", actorId: changes.actorId, createdAt: ticket.updatedAt });
      this.audits.set(ticketNumber, audits);
    }
    return (await this.getTicketDetail(ticketNumber))!;
  }
}

export function createPostgresTicketRepository(): PostgresTicketRepository {
  return new PostgresTicketRepository(getDatabasePool(), process.env.ADMIN_WHATSAPP_NUMBER);
}
