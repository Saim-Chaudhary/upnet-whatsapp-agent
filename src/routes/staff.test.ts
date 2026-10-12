import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import staffRoutes from "./staff.js";
import { hashPassword, verifyPassword } from "../staff/auth.js";

test("password hashing uses a per-user salt and timing-safe verification", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("wrong", first), false);
});

test("staff routes require authentication and CSRF for updates", async () => {
  const app = Fastify();
  const actor = { id: "staff-1", email: "agent@example.com", displayName: "Agent", role: "agent" as const };
  const auth = {
    async authenticate(headers: Record<string, string | string[] | undefined>) {
      if (!headers.cookie) return undefined;
      return { actor, csrfToken: "csrf", sessionId: "session" };
    },
    async login() { return { token: "token", csrfToken: "csrf", actor }; },
    async logout() {},
  };
  const ticket = {
    async createTicket() { throw new Error("unused"); },
    async overridePriority() { throw new Error("unused"); },
    async listTickets() { return { tickets: [], page: 1, pageSize: 25, total: 0 }; },
    async getTicketDetail() { return undefined; },
    async updateTicket() { throw new Error("unused"); },
  };
  await app.register(staffRoutes, { auth, tickets: ticket });
  await app.ready();
  const unauthenticated = await app.inject({ method: "GET", url: "/api/staff/tickets" });
  assert.equal(unauthenticated.statusCode, 401);
  const forbidden = await app.inject({ method: "PATCH", url: "/api/staff/tickets/UP-1", headers: { cookie: "upnet_staff_session=token" }, payload: { status: "Resolved", expectedUpdatedAt: new Date().toISOString() } });
  assert.equal(forbidden.statusCode, 403);
  await app.close();
});

test("notification monitoring masks recipients and only retries failed jobs", async () => {
  const app = Fastify();
  const actor = { id: "staff-1", email: "agent@example.com", displayName: "Agent", role: "agent" as const };
  const auth = {
    async authenticate(headers: Record<string, string | string[] | undefined>) {
      if (!headers.cookie) return undefined;
      return { actor, csrfToken: "csrf", sessionId: "session" };
    },
    async login() { return { token: "token", csrfToken: "csrf", actor }; },
    async logout() {},
  };
  const notifications = {
    async list() {
      return [{
        id: "job-1", dedupeKey: "ticket:UP-1", recipient: "923001234567@c.us", text: "private message",
        kind: "ticket_created_admin" as const, status: "failed" as const, attempts: 2,
        availableAt: new Date(), createdAt: new Date(), updatedAt: new Date(), lastError: "provider timeout",
      }];
    },
    async retry(id: string) { return id === "job-1"; },
  };
  await app.register(staffRoutes, { auth, notifications });
  await app.ready();
  const listed = await app.inject({ method: "GET", url: "/api/staff/notifications?status=failed", headers: { cookie: "session" } });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json()[0].recipient, "923••••567@c.us");
  assert.equal("text" in listed.json()[0], false);
  const invalid = await app.inject({ method: "GET", url: "/api/staff/notifications?status=unknown", headers: { cookie: "session" } });
  assert.equal(invalid.statusCode, 400);
  const retry = await app.inject({ method: "POST", url: "/api/staff/notifications/job-1/retry", headers: { cookie: "session", "x-csrf-token": "csrf" } });
  assert.equal(retry.statusCode, 200);
  const forbidden = await app.inject({ method: "POST", url: "/api/staff/notifications/job-1/retry", headers: { cookie: "session" } });
  assert.equal(forbidden.statusCode, 403);
  await app.close();
});

test("maintenance mutations require CSRF and validate lifecycle status", async () => {
  const app = Fastify();
  const actor = { id: "staff-1", email: "agent@example.com", displayName: "Agent", role: "agent" as const };
  const auth = {
    async authenticate(headers: Record<string, string | string[] | undefined>) {
      if (!headers.cookie) return undefined;
      return { actor, csrfToken: "csrf", sessionId: "session" };
    },
    async login() { return { token: "token", csrfToken: "csrf", actor }; },
    async logout() {},
  };
  const maintenance = {
    async list() { return []; },
    async create() { throw new Error("unused"); },
    async get() { return undefined; },
    async updateStatus() { throw new Error("unused"); },
  };
  await app.register(staffRoutes, { auth, maintenance });
  await app.ready();
  const forbidden = await app.inject({ method: "POST", url: "/api/staff/maintenance", headers: { cookie: "session" }, payload: {} });
  assert.equal(forbidden.statusCode, 403);
  const invalid = await app.inject({ method: "GET", url: "/api/staff/maintenance?status=Unknown", headers: { cookie: "session" } });
  assert.equal(invalid.statusCode, 400);
  await app.close();
});
