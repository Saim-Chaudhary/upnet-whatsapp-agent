import assert from "node:assert/strict";
import test from "node:test";
import { buildApp } from "./app.js";

test("local chat validates messages and can reset a conversation", async () => {
  const app = buildApp();
  await app.ready();

  const invalid = await app.inject({
    method: "POST",
    url: "/local/chat/http-test",
    payload: { message: "" },
  });
  assert.equal(invalid.statusCode, 400);

  const reset = await app.inject({
    method: "DELETE",
    url: "/local/chat/http-test",
  });
  assert.equal(reset.statusCode, 200);
  assert.deepEqual(reset.json(), {
    reset: false,
    conversationId: "http-test",
  });

  await app.close();
});
