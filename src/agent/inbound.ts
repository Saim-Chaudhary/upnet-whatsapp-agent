import { Pool } from "pg";
import type { AgentReply } from "./service.js";

export type InboundClaim =
  | { kind: "claimed" }
  | { kind: "completed"; reply: AgentReply }
  | { kind: "processing" };

export interface InboundMessageStore {
  claim(messageId: string, conversationId: string): Promise<InboundClaim>;
  complete(messageId: string, reply: AgentReply): Promise<void>;
  fail(messageId: string): Promise<void>;
}

type InboundRow = {
  status: "processing" | "completed" | "failed";
  response: AgentReply | null;
};

export class PostgresInboundMessageStore implements InboundMessageStore {
  constructor(private readonly pool: Pool) {}

  async claim(messageId: string, conversationId: string): Promise<InboundClaim> {
    const inserted = await this.pool.query(
      `INSERT INTO inbound_messages (message_id, conversation_id)
       VALUES ($1, $2)
       ON CONFLICT (message_id) DO NOTHING
       RETURNING message_id`,
      [messageId, conversationId],
    );
    if (inserted.rowCount === 1) return { kind: "claimed" };

    const row = await this.pool.query<InboundRow>(
      "SELECT status, response FROM inbound_messages WHERE message_id = $1",
      [messageId],
    );
    const existing = row.rows[0];
    if (!existing) throw new Error("Inbound message claim disappeared");
    if (existing.status === "completed" && existing.response) {
      return { kind: "completed", reply: existing.response };
    }

    if (existing.status === "processing") return { kind: "processing" };

    const retried = await this.pool.query(
      `UPDATE inbound_messages
       SET status = 'processing', response = NULL, updated_at = NOW()
       WHERE message_id = $1 AND status = 'failed'
       RETURNING message_id`,
      [messageId],
    );
    return retried.rowCount === 1 ? { kind: "claimed" } : { kind: "processing" };
  }

  async complete(messageId: string, reply: AgentReply): Promise<void> {
    await this.pool.query(
      `UPDATE inbound_messages
       SET status = 'completed', response = $2::jsonb, updated_at = NOW()
       WHERE message_id = $1`,
      [messageId, JSON.stringify(reply)],
    );
  }

  async fail(messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE inbound_messages
       SET status = 'failed', updated_at = NOW()
       WHERE message_id = $1 AND status = 'processing'`,
      [messageId],
    );
  }
}

export class InMemoryInboundMessageStore implements InboundMessageStore {
  private readonly messages = new Map<
    string,
    {
      conversationId: string;
      status: "processing" | "completed" | "failed";
      response?: AgentReply;
    }
  >();

  async claim(messageId: string, conversationId: string): Promise<InboundClaim> {
    const existing = this.messages.get(messageId);
    if (!existing) {
      this.messages.set(messageId, { conversationId, status: "processing" });
      return { kind: "claimed" };
    }
    if (existing.status === "completed" && existing.response) {
      return { kind: "completed", reply: existing.response };
    }
    if (existing.status === "failed") {
      existing.status = "processing";
      delete existing.response;
      return { kind: "claimed" };
    }
    return { kind: "processing" };
  }

  async complete(messageId: string, response: AgentReply): Promise<void> {
    const message = this.messages.get(messageId);
    if (!message) throw new Error("Inbound message was not claimed");
    message.status = "completed";
    message.response = response;
  }

  async fail(messageId: string): Promise<void> {
    const message = this.messages.get(messageId);
    if (message) message.status = "failed";
  }
}
