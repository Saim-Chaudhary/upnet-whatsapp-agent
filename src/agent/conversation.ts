import { BaseMessage } from "@langchain/core/messages";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Pool } from "pg";

export type ConversationStage =
  | "initial"
  | "router_check"
  | "restart_router"
  | "internet_status"
  | "billing_check"
  | "payment_proof"
  | "ready_for_ticket"
  | "resolved"
  | "payment_required";

export type ConversationState = {
  messages: BaseMessage[];
  stage: ConversationStage;
  pendingTicketRequestId?: string;
};

export interface ConversationStore {
  load(chatId: string): Promise<ConversationState>;
  save(chatId: string, conversation: ConversationState): Promise<void>;
  reset(chatId: string): Promise<boolean>;
  withLock<T>(chatId: string, operation: () => Promise<T>): Promise<T>;
}

const conversations = new Map<string, ConversationState>();

function createConversation(): ConversationState {
  return { messages: [], stage: "initial" };
}

export function getConversation(chatId: string): ConversationState {
  let conversation = conversations.get(chatId);

  if (!conversation) {
    conversation = createConversation();
    conversations.set(chatId, conversation);
  }

  return conversation;
}

export function resetConversation(chatId: string): boolean {
  return conversations.delete(chatId);
}

export class InMemoryConversationStore implements ConversationStore {
  private readonly locks = new Map<string, Promise<void>>();

  async load(chatId: string): Promise<ConversationState> {
    return getConversation(chatId);
  }

  async save(chatId: string, conversation: ConversationState): Promise<void> {
    conversations.set(chatId, conversation);
  }

  async reset(chatId: string): Promise<boolean> {
    return resetConversation(chatId);
  }

  async withLock<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(chatId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.locks.set(chatId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(chatId) === queued) this.locks.delete(chatId);
    }
  }
}

type ConversationRow = {
  stage: ConversationStage;
  pending_ticket_request_id: string | null;
};

type MessageRow = {
  role: "human" | "ai" | "system";
  content: string;
};

export class PostgresConversationStore implements ConversationStore {
  constructor(private readonly pool: Pool) {}

  async load(chatId: string): Promise<ConversationState> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const conversation = await client.query<ConversationRow>(
        `INSERT INTO conversations (conversation_id)
         VALUES ($1)
         ON CONFLICT (conversation_id) DO UPDATE
         SET updated_at = NOW()
         RETURNING stage, pending_ticket_request_id`,
        [chatId],
      );
      const row = conversation.rows[0];
      if (!row) {
        throw new Error("Conversation row was not returned");
      }
      const messages = await client.query<MessageRow>(
        `SELECT role, content FROM conversation_messages
         WHERE conversation_id = $1 ORDER BY sequence_number`,
        [chatId],
      );
      await client.query("COMMIT");
      return {
        stage: row.stage,
        messages: messages.rows.map((message) => {
          if (message.role === "human") return new HumanMessage(message.content);
          if (message.role === "ai") return new AIMessage(message.content);
          return new SystemMessage(message.content);
        }),
        ...(row.pending_ticket_request_id
          ? { pendingTicketRequestId: row.pending_ticket_request_id }
          : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async save(chatId: string, conversation: ConversationState): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE conversations
         SET stage = $2, pending_ticket_request_id = $3, updated_at = NOW()
         WHERE conversation_id = $1`,
        [chatId, conversation.stage, conversation.pendingTicketRequestId ?? null],
      );
      await client.query(
        "DELETE FROM conversation_messages WHERE conversation_id = $1",
        [chatId],
      );
      for (const [index, message] of conversation.messages.entries()) {
        const role =
          message.getType() === "human"
            ? "human"
            : message.getType() === "ai"
              ? "ai"
              : "system";
        await client.query(
          `INSERT INTO conversation_messages
            (conversation_id, sequence_number, role, content)
           VALUES ($1, $2, $3, $4)`,
          [chatId, index, role, String(message.content)],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reset(chatId: string): Promise<boolean> {
    const result = await this.pool.query(
      "DELETE FROM conversations WHERE conversation_id = $1",
      [chatId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async withLock<T>(chatId: string, operation: () => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO conversation_locks (conversation_id)
         VALUES ($1)
         ON CONFLICT (conversation_id) DO NOTHING`,
        [chatId],
      );
      await client.query(
        "SELECT conversation_id FROM conversation_locks WHERE conversation_id = $1 FOR UPDATE",
        [chatId],
      );
      const result = await operation();
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}