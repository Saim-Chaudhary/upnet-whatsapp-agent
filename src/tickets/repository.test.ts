import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryTicketRepository,
  TicketDraft,
  validateTicketDraft,
} from "./repository.js";

const draft = (idempotencyKey: string): TicketDraft => ({
  idempotencyKey,
  customerPhone: "923001234567",
  problemDescription: "Internet remains unavailable after restart.",
  troubleshootingSteps: "Router restart completed.",
  priority: "Normal",
  priorityReason: "Impact is not fully confirmed.",
});

test("persists tickets with unique numbers under concurrent requests", async () => {
  const repository = new InMemoryTicketRepository();
  const tickets = await Promise.all(
    ["conversation-a", "conversation-b", "conversation-c"].map((key) =>
      repository.createTicket(draft(key)),
    ),
  );

  assert.equal(new Set(tickets.map((ticket) => ticket.ticketNumber)).size, 3);
  assert.deepEqual(
    tickets.map((ticket) => ticket.ticketNumber).sort(),
    ["UP-1001", "UP-1002", "UP-1003"],
  );
});

test("returns the same ticket for a retried idempotency key", async () => {
  const repository = new InMemoryTicketRepository();
  const first = await repository.createTicket(draft("retry-key"));
  const second = await repository.createTicket(draft("retry-key"));

  assert.equal(second.id, first.id);
  assert.equal(second.ticketNumber, first.ticketNumber);
});

test("allows the same customer to create a later complaint with a new request key", async () => {
  const repository = new InMemoryTicketRepository();
  const first = await repository.createTicket({
    ...draft("whatsapp:event-1"),
    customerPhone: "923001234567",
    problemDescription: "Internet is unavailable.",
  });
  const second = await repository.createTicket({
    ...draft("whatsapp:event-2"),
    customerPhone: "923001234567",
    problemDescription: "Billing account needs review.",
  });

  assert.notEqual(second.id, first.id);
  assert.notEqual(second.ticketNumber, first.ticketNumber);
});

test("records authorized priority overrides in audit history", async () => {
  const repository = new InMemoryTicketRepository();
  const ticket = await repository.createTicket(draft("override-key"));
  const result = await repository.overridePriority(
    ticket.ticketNumber,
    "High",
    "Multiple locations reported service loss.",
    { actorId: "staff-1", role: "staff" },
  );

  assert.equal(result.ticket.priority, "High");
  assert.equal(result.audit.previousPriority, "Normal");
  assert.equal(repository.getAudits(ticket.ticketNumber).length, 1);
});

test("rejects unauthorized priority overrides", async () => {
  const repository = new InMemoryTicketRepository();
  const ticket = await repository.createTicket(draft("unauthorized-key"));

  await assert.rejects(
    repository.overridePriority(
      ticket.ticketNumber,
      "Urgent",
      "not authorized",
      { actorId: "customer-1", role: "customer" as never },
    ),
    /Staff authorization is required/,
  );
});

test("validates required ticket fields", () => {
  assert.throws(
    () =>
      validateTicketDraft({
        ...draft("missing-description"),
        problemDescription: " ",
      }),
    /Problem description is required/,
  );
});
