import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenWaSender,
  NotificationDispatcher,
  type NotificationJob,
} from "./jobs.js";

const job: NotificationJob = {
  id: "job-1",
  dedupeKey: "ticket-created:1",
  recipient: "923001234567@c.us",
  text: "New ticket UP-1001",
  kind: "ticket_created",
  status: "processing",
  attempts: 1,
  availableAt: new Date(),
};

test("uses the OpenWA send-text endpoint and documented request body", async () => {
  const previousFetch = globalThis.fetch;
  const previous = {
    url: process.env.OPENWA_URL,
    session: process.env.OPENWA_SESSION_ID,
    key: process.env.OPENWA_API_KEY,
  };
  let request: { url: string; init: RequestInit } | undefined;
  process.env.OPENWA_URL = "http://openwa.test";
  process.env.OPENWA_SESSION_ID = "session-1";
  process.env.OPENWA_API_KEY = "test-key";
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init: init ?? {} };
    return new Response("{}", { status: 200 });
  };
  try {
    await createOpenWaSender()(job);
    assert.equal(request?.url, "http://openwa.test/api/sessions/session-1/messages/send-text");
    assert.equal(request?.init.method, "POST");
    assert.deepEqual(JSON.parse(String(request?.init.body)), {
      chatId: "923001234567@c.us",
      text: "New ticket UP-1001",
    });
    assert.equal((request?.init.headers as Record<string, string>)["X-API-Key"], "test-key");
    assert.equal((request?.init.headers as Record<string, string>)["X-Idempotency-Key"], undefined);
  } finally {
    globalThis.fetch = previousFetch;
    if (previous.url === undefined) delete process.env.OPENWA_URL; else process.env.OPENWA_URL = previous.url;
    if (previous.session === undefined) delete process.env.OPENWA_SESSION_ID; else process.env.OPENWA_SESSION_ID = previous.session;
    if (previous.key === undefined) delete process.env.OPENWA_API_KEY; else process.env.OPENWA_API_KEY = previous.key;
  }
});

test("dispatcher retries a failed provider delivery through the job store", async () => {
  const calls: string[] = [];
  let attempts = 0;
  const jobs = {
    async claim() {
      if (attempts === 0) {
        attempts++;
        return [job];
      }
      return [];
    },
    async markSent(id: string) { calls.push(`sent:${id}`); },
    async markFailed(id: string) { calls.push(`failed:${id}`); },
  };
  const dispatcher = new NotificationDispatcher(
    jobs as never,
    async () => { throw new Error("provider unavailable"); },
  );
  await dispatcher.process();
  assert.deepEqual(calls, ["failed:job-1"]);
});
