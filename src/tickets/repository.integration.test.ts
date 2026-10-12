import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { Pool } from "pg";
import { migrateDatabase } from "../db/migrate.js";
import { PostgresConversationStore } from "../agent/conversation.js";
import { PostgresInboundMessageStore } from "../agent/inbound.js";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { handleAgentMessage } from "../agent/service.js";
import type { IntentClassifier } from "../agent/upnetAgent.js";
import { PostgresTicketRepository, TicketDraft } from "./repository.js";

const connectionString = process.env.PG_TEST_DATABASE_URL;
const databaseName = connectionString
  ? new URL(connectionString).pathname.slice(1)
  : "";
const canRun =
  Boolean(connectionString) && /^upnet_test(?:[_-]|$)/i.test(databaseName);

const integrationTest = canRun
  ? (name: string, fn: () => Promise<void>) =>
      test(name, { concurrency: false }, fn)
  : test.skip;
let pool: Pool;
let repository: PostgresTicketRepository;

const draft = (idempotencyKey: string): TicketDraft => ({
  idempotencyKey,
  customerPhone: "923001234567",
  problemDescription: "Internet remains unavailable after restart.",
  troubleshootingSteps: "Router restart completed.",
  priority: "Normal",
  priorityReason: "Impact is not fully confirmed.",
});

before(async () => {
  if (!connectionString) {
    return;
  }
  if (!canRun) {
    throw new Error(
      "PG_TEST_DATABASE_URL must point to a database named upnet_test, upnet_test_*, or upnet_test-*",
    );
  }

  await migrateDatabase(connectionString);
  pool = new Pool({ connectionString });
  await pool.query(
    "TRUNCATE ticket_priority_audit, support_tickets, notification_jobs, conversation_messages, conversations, conversation_locks, inbound_messages RESTART IDENTITY CASCADE",
  );
  await pool.query(
    "ALTER SEQUENCE upnet_ticket_number_seq RESTART WITH 1001",
  );
  repository = new PostgresTicketRepository(pool);
});

after(async () => {
  await pool?.end();
});

integrationTest("applies the schema and persists a ticket", async () => {
  const ticket = await repository.createTicket(draft("integration:create"));

  assert.match(ticket.ticketNumber, /^UP-1001$/);
  const result = await pool.query(
    "SELECT id, ticket_number FROM support_tickets WHERE idempotency_key = $1",
    ["integration:create"],
  );
  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0].ticket_number, ticket.ticketNumber);
});

integrationTest("enqueues durable admin and customer notifications after ticket transactions", async () => {
  const withNotifications = new PostgresTicketRepository(pool, "923009999999");
  const ticket = await withNotifications.createTicket(draft("integration:notifications"));
  let jobs = await pool.query(
    "SELECT recipient, kind, status FROM notification_jobs WHERE dedupe_key = $1",
    [`ticket-created:${ticket.id}`],
  );
  assert.deepEqual(jobs.rows, [{ recipient: "923009999999@c.us", kind: "ticket_created", status: "pending" }]);

  const detail = await withNotifications.getTicketDetail!(ticket.ticketNumber);
  await withNotifications.updateTicket!(ticket.ticketNumber, {
    status: "Resolved",
    expectedUpdatedAt: detail!.ticket.updatedAt,
    actorId: "integration-admin",
  });
  jobs = await pool.query(
    "SELECT recipient, kind, status FROM notification_jobs WHERE dedupe_key LIKE $1",
    [`ticket-resolved:${ticket.id}:%`],
  );
  assert.deepEqual(jobs.rows, [{ recipient: "923001234567@c.us", kind: "ticket_resolved", status: "pending" }]);
});

integrationTest("reuses duplicate requests and allows a second complaint", async () => {
  const first = await repository.createTicket(draft("integration:event-1"));
  const retry = await repository.createTicket({
    ...draft("integration:event-1"),
    problemDescription: "A changed retry payload must not create another ticket.",
  });
  const second = await repository.createTicket({
    ...draft("integration:event-2"),
    problemDescription: "A separate later complaint.",
  });

  assert.equal(retry.id, first.id);
  assert.equal(retry.ticketNumber, first.ticketNumber);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.ticketNumber, first.ticketNumber);
});

integrationTest("generates unique numbers concurrently", async () => {
  const tickets = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      repository.createTicket(draft(`integration:concurrent-${index}`)),
    ),
  );

  assert.equal(
    new Set(tickets.map((ticket) => ticket.ticketNumber)).size,
    tickets.length,
  );
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count,
            COUNT(DISTINCT ticket_number)::int AS unique_count
     FROM support_tickets
     WHERE idempotency_key LIKE 'integration:concurrent-%'`,
  );
  assert.equal(result.rows[0].count, 10);
  assert.equal(result.rows[0].unique_count, 10);
});

integrationTest("updates priority and writes its audit record atomically", async () => {
  const ticket = await repository.createTicket(draft("integration:audit"));
  const result = await repository.overridePriority(
    ticket.ticketNumber,
    "High",
    "Multiple locations reported service loss.",
    { actorId: "integration-staff", role: "staff" },
  );

  assert.equal(result.ticket.priority, "High");
  const audit = await pool.query(
    "SELECT previous_priority, new_priority, actor_id FROM ticket_priority_audit WHERE ticket_id = $1",
    [ticket.id],
  );
  assert.deepEqual(audit.rows, [
    {
      previous_priority: "Normal",
      new_priority: "High",
      actor_id: "integration-staff",
    },
  ]);
});

integrationTest("persists conversation state across store instances", async () => {
  const firstStore = new PostgresConversationStore(pool);
  const secondStore = new PostgresConversationStore(pool);
  const conversation = await firstStore.load("integration:conversation");
  conversation.stage = "router_check";
  conversation.messages.push(new HumanMessage("Internet is down."));
  await firstStore.save("integration:conversation", conversation);

  const restored = await secondStore.load("integration:conversation");
  assert.equal(restored.stage, "router_check");
  assert.equal(String(restored.messages[0]?.content), "Internet is down.");
});

integrationTest("persists inbound completion and replays duplicate message IDs", async () => {
  const inbound = new PostgresInboundMessageStore(pool);
  const messageId = `integration:message-${Date.now()}`;
  assert.deepEqual(
    await inbound.claim(messageId, "integration:conversation"),
    { kind: "claimed" },
  );
  const response = {
    conversationId: "integration:conversation",
    reply: "Your ticket is UP-1001.",
    stage: "ready_for_ticket" as const,
    ticketNumber: "UP-1001",
  };
  await inbound.complete(messageId, response);
  assert.deepEqual(
    await inbound.claim(messageId, "integration:conversation"),
    { kind: "completed", reply: response },
  );
});

integrationTest("serializes concurrent service messages across PostgreSQL store instances", async () => {
  const firstPool = new Pool({ connectionString: connectionString! });
  const secondPool = new Pool({ connectionString: connectionString! });
  const conversationId = `integration:lock-${Date.now()}`;
  const firstStore = new PostgresConversationStore(firstPool);
  const secondStore = new PostgresConversationStore(secondPool);
  const firstInbound = new PostgresInboundMessageStore(firstPool);
  const secondInbound = new PostgresInboundMessageStore(secondPool);
  const invoke = async () => ({ messages: [new AIMessage("Next step")] });
  const classify: IntentClassifier = async ({ stage }) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return stage === "initial"
      ? { intent: "internet_complaint", confidence: "high" }
      : { intent: "router_no_red_light", confidence: "high" };
  };

  try {
    await Promise.all([
      handleAgentMessage(
        conversationId,
        "Internet is down.",
        invoke,
        classify,
        undefined,
        undefined,
        { requestId: `${conversationId}:message-1` },
        firstStore,
        firstInbound,
      ),
      handleAgentMessage(
        conversationId,
        "All router lights are green.",
        invoke,
        classify,
        undefined,
        undefined,
        { requestId: `${conversationId}:message-2` },
        secondStore,
        secondInbound,
      ),
    ]);

    const restored = await firstStore.load(conversationId);
    assert.equal(restored.stage, "restart_router");
    assert.deepEqual(
      restored.messages
        .filter((message) => message.getType() === "human")
        .map((message) => String(message.content))
        .sort(),
      ["All router lights are green.", "Internet is down."],
    );
  } finally {
    await Promise.all([firstPool.end(), secondPool.end()]);
  }
});

integrationTest("reclaims an inbound message after a failed attempt", async () => {
  const inbound = new PostgresInboundMessageStore(pool);
  assert.deepEqual(
    await inbound.claim("integration:failed-message", "integration:conversation"),
    { kind: "claimed" },
  );
  await inbound.fail("integration:failed-message");
  assert.deepEqual(
    await inbound.claim("integration:failed-message", "integration:conversation"),
    { kind: "claimed" },
  );
});

integrationTest("keeps existing tickets compatible with additive migrations", async () => {
  const key = `integration:existing-ticket-${Date.now()}`;
  const ticket = await repository.createTicket(draft(key));
  await migrateDatabase(connectionString!);
  const retry = await repository.createTicket(draft(key));

  assert.equal(retry.id, ticket.id);
  assert.equal(retry.ticketNumber, ticket.ticketNumber);
});
