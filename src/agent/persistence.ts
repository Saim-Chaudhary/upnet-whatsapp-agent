import { InMemoryConversationStore, PostgresConversationStore } from "./conversation.js";
import { InMemoryInboundMessageStore, PostgresInboundMessageStore } from "./inbound.js";
import { getDatabasePool } from "../db/pool.js";

export type AgentStores = {
  conversation: InMemoryConversationStore | PostgresConversationStore;
  inbound?: PostgresInboundMessageStore | InMemoryInboundMessageStore;
};

let stores: AgentStores | undefined;

export function getPersistentAgentStores(): AgentStores {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is required for production PostgreSQL persistence",
    );
  }
  if (!stores) {
    const pool = getDatabasePool();
    stores = {
      conversation: new PostgresConversationStore(pool),
      inbound: new PostgresInboundMessageStore(pool),
    };
  }
  return stores;
}
