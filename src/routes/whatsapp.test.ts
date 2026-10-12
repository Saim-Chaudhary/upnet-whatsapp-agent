import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryConversationStore } from "../agent/conversation.js";
import { InMemoryInboundMessageStore } from "../agent/inbound.js";
import {
  isAuthorizedAdminSender,
  parseAdminTicketCommand,
  processAdminTicketCommand,
} from "./whatsapp.js";
import type { Ticket, TicketStatus } from "../tickets/repository.js";

test("parses only supported admin ticket commands", () => {
  assert.deepEqual(parseAdminTicketCommand("UP-1001 IN_PROGRESS"), {
    ticketNumber: "UP-1001",
    status: "In Progress",
  });
  assert.deepEqual(parseAdminTicketCommand("up-1001 resolved"), {
    ticketNumber: "UP-1001",
    status: "Resolved",
  });
  assert.equal(parseAdminTicketCommand("UP-1001 maybe"), undefined);
});

test("authenticates the configured WhatsApp admin sender", () => {
  const previous = process.env.ADMIN_WHATSAPP_NUMBER;
  process.env.ADMIN_WHATSAPP_NUMBER = "923001234567";
  try {
    assert.equal(isAuthorizedAdminSender("923001234567@c.us"), true);
    assert.equal(isAuthorizedAdminSender("923009999999@c.us"), false);
  } finally {
    if (previous === undefined) delete process.env.ADMIN_WHATSAPP_NUMBER;
    else process.env.ADMIN_WHATSAPP_NUMBER = previous;
  }
});

test("admin command updates a ticket and replays duplicate webhook delivery", async () => {
  const calls: Array<{ status: string; actorId: string }> = [];
  const ticket: Ticket = {
    id: "1",
    idempotencyKey: "test",
    ticketNumber: "UP-1001",
    customerPhone: "923001234567",
    problemDescription: "Internet unavailable",
    troubleshootingSteps: "Restart completed",
    priority: "Normal",
    priorityReason: "Unknown impact",
    status: "Open",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const tickets = {
    async getTicketDetail() {
      return { ticket, customerHistory: [], auditHistory: [] };
    },
    async updateTicket(_number: string, changes: { status?: TicketStatus; actorId: string }) {
      calls.push({ status: changes.status ?? "", actorId: changes.actorId });
      ticket.status = changes.status ?? ticket.status;
      return { ticket, customerHistory: [], auditHistory: [] };
    },
  };
  const stores = {
    conversation: new InMemoryConversationStore(),
    inbound: new InMemoryInboundMessageStore(),
  };
  const message = { author: "923001234567@c.us", id: "wamid-1" };
  const command = parseAdminTicketCommand("UP-1001 IN_PROGRESS")!;

  const first = await processAdminTicketCommand(message, command, stores, tickets);
  const retry = await processAdminTicketCommand(message, command, stores, tickets);

  assert.equal(first?.reply, "UP-1001 is now In Progress.");
  assert.equal(retry?.reply, first?.reply);
  assert.equal(retry?.replayed, true);
  assert.deepEqual(calls, [{ status: "In Progress", actorId: "whatsapp-admin:923001234567" }]);
});
