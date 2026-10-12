import { randomUUID } from "node:crypto";
import { Pool, PoolClient } from "pg";

export type NotificationJob = {
  id: string;
  dedupeKey: string;
  recipient: string;
  text: string;
  kind: "ticket_created" | "ticket_resolved";
  status: "pending" | "processing" | "sent" | "failed";
  attempts: number;
  availableAt: Date;
};

export type NotificationSender = (job: NotificationJob) => Promise<void>;

export function whatsappChatId(value: string): string {
  return value.includes("@") ? value : `${value}@c.us`;
}

export async function enqueueNotification(
  client: PoolClient,
  job: { dedupeKey: string; recipient: string; text: string; kind: NotificationJob["kind"] },
): Promise<void> {
  await client.query(
    `INSERT INTO notification_jobs
      (id, dedupe_key, recipient, text, kind)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [randomUUID(), job.dedupeKey, job.recipient, job.text, job.kind],
  );
}

export class PostgresNotificationJobStore {
  constructor(private readonly pool: Pool) {}

  async list(status?: NotificationJob["status"]): Promise<Array<NotificationJob & {
    createdAt: Date;
    updatedAt: Date;
    lastError?: string;
  }>> {
    const values: string[] = [];
    const filter = status ? "WHERE status = $1" : "";
    if (status) values.push(status);
    const result = await this.pool.query<{
      id: string; dedupe_key: string; recipient: string; text: string;
      kind: NotificationJob["kind"]; status: NotificationJob["status"];
      attempts: number; available_at: Date; created_at: Date; updated_at: Date;
      last_error: string | null;
    }>(
      `SELECT id, dedupe_key, recipient, text, kind, status, attempts,
              available_at, created_at, updated_at, last_error
       FROM notification_jobs ${filter} ORDER BY created_at DESC LIMIT 100`,
      values,
    );
    return result.rows.map((row) => ({
      id: row.id,
      dedupeKey: row.dedupe_key,
      recipient: row.recipient,
      text: row.text,
      kind: row.kind,
      status: row.status,
      attempts: row.attempts,
      availableAt: row.available_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.last_error ? { lastError: row.last_error } : {}),
    }));
  }

  async retry(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE notification_jobs
       SET status = 'pending', available_at = NOW(), last_error = NULL,
           updated_at = NOW()
       WHERE id = $1 AND status = 'failed'`,
      [id],
    );
    return result.rowCount === 1;
  }

  async claim(limit = 10): Promise<NotificationJob[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        id: string; dedupe_key: string; recipient: string; text: string;
        kind: NotificationJob["kind"]; status: NotificationJob["status"];
        attempts: number; available_at: Date;
      }>(
        `SELECT id, dedupe_key, recipient, text, kind, status, attempts, available_at
         FROM notification_jobs
         WHERE (status IN ('pending', 'failed') AND available_at <= NOW())
            OR (status = 'processing' AND locked_at < NOW() - INTERVAL '5 minutes')
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      const jobs: NotificationJob[] = [];
      for (const row of result.rows) {
        await client.query(
          `UPDATE notification_jobs
           SET status = 'processing', attempts = attempts + 1,
               locked_at = NOW(), updated_at = NOW()
           WHERE id = $1`,
          [row.id],
        );
        jobs.push({
          id: row.id, dedupeKey: row.dedupe_key, recipient: row.recipient,
          text: row.text, kind: row.kind, status: "processing",
          attempts: row.attempts + 1, availableAt: row.available_at,
        });
      }
      await client.query("COMMIT");
      return jobs;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markSent(id: string): Promise<void> {
    await this.pool.query(
      "UPDATE notification_jobs SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'processing'",
      [id],
    );
  }

  async markFailed(id: string, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Notification failed";
    await this.pool.query(
      `UPDATE notification_jobs
       SET status = 'failed', last_error = $2,
           available_at = NOW() + INTERVAL '1 minute', updated_at = NOW()
       WHERE id = $1 AND status = 'processing'`,
      [id, message],
    );
  }
}

export class NotificationDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly jobs: PostgresNotificationJobStore,
    private readonly sender: NotificationSender,
  ) {}

  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.process().catch((error) => {
        console.error("Notification dispatch failed:", error);
      });
    }, intervalMs);
    this.timer.unref();
    void this.process().catch((error) => {
      console.error("Notification dispatch failed:", error);
    });
  }

  async process(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of await this.jobs.claim()) {
        try {
          await this.sender(job);
          await this.jobs.markSent(job.id);
        } catch (error) {
          await this.jobs.markFailed(job.id, error);
          console.error("Notification delivery failed:", error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function createOpenWaSender(): NotificationSender {
  return async (job) => {
    const baseUrl = process.env.OPENWA_URL;
    const sessionId = process.env.OPENWA_SESSION_ID;
    const apiKey = process.env.OPENWA_API_KEY;
    if (!baseUrl || !sessionId || !apiKey) {
      throw new Error("OPENWA_URL, OPENWA_SESSION_ID, and OPENWA_API_KEY are required");
    }
    const timeoutMs = Number(process.env.OPENWA_TIMEOUT_MS ?? 15000);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error("OPENWA_TIMEOUT_MS must be a positive number");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(
      `${baseUrl}/api/sessions/${sessionId}/messages/send-text`,
      {
        method: "POST",
        headers: {
          "X-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ chatId: job.recipient, text: job.text }),
        signal: controller.signal,
      },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`OpenWA request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error(`OpenWA returned ${response.status}`);
  };
}
