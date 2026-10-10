import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage } from "@langchain/core/messages";
import { handleAgentMessage } from "./service.js";
import { resetConversation } from "./conversation.js";
import type { IntentClassificationInput, IntentClassifier } from "./upnetAgent.js";
import type { CustomerIntent } from "./workflow.js";

const reply = async () => ({
  messages: [new AIMessage("Next step")],
});

function classifierFor(
  intent: CustomerIntent,
): IntentClassifier {
  return async () => ({
    intent,
    confidence: "high",
  });
}

test("injects the classifier and passes stage and recent context", async () => {
  const conversationId = "classifier-context-test";
  resetConversation(conversationId);
  const inputs: IntentClassificationInput[] = [];
  const classify: IntentClassifier = async (input) => {
    inputs.push(input);
    return { intent: "internet_complaint", confidence: "high" };
  };

  const result = await handleAgentMessage(conversationId, "Net nahi chal raha", reply, classify);

  assert.equal(result.stage, "router_check");
  assert.equal(inputs[0]?.stage, "initial");
  assert.equal(inputs[0]?.latestMessage, "Net nahi chal raha");
  assert.deepEqual(inputs[0]?.recentMessages, []);
  resetConversation(conversationId);
});

test("keeps the latest customer message separate from assistant context", async () => {
  const conversationId = "classifier-message-boundaries-test";
  resetConversation(conversationId);
  const inputs: IntentClassificationInput[] = [];
  const classify: IntentClassifier = async (input) => {
    inputs.push(input);
    return {
      intent: inputs.length === 1 ? "internet_complaint" : "router_no_red_light",
      confidence: "high",
    };
  };

  await handleAgentMessage(conversationId, "Internet down hai", reply, classify);
  await handleAgentMessage(conversationId, "Sab green hain", reply, classify);

  assert.equal(inputs[1]?.latestMessage, "Sab green hain");
  assert.equal(inputs[1]?.recentMessages.some((message) =>
    message.content === "Sab green hain"), false);
  assert.equal(inputs[1]?.recentMessages.some((message) =>
    message.content === "Next step"), true);
  resetConversation(conversationId);
});

test("accepts medium confidence but rejects low confidence without advancing", async () => {
  const mediumConversationId = "medium-confidence-test";
  resetConversation(mediumConversationId);
  const medium = await handleAgentMessage(
    mediumConversationId,
    "Internet down",
    reply,
    async () => ({ intent: "internet_complaint", confidence: "medium" }),
  );
  assert.equal(medium.stage, "router_check");
  resetConversation(mediumConversationId);

  const lowConversationId = "low-confidence-test";
  resetConversation(lowConversationId);
  const low = await handleAgentMessage(
    lowConversationId,
    "Internet down",
    reply,
    async () => ({ intent: "internet_complaint", confidence: "low" }),
  );
  assert.equal(low.stage, "initial");
  assert.match(low.reply, /did not understand/i);
  resetConversation(lowConversationId);
});

test("preserves the stage and continues after a classifier failure", async () => {
  const conversationId = "classifier-retry-test";
  resetConversation(conversationId);
  let attempts = 0;
  const classify: IntentClassifier = async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("provider unavailable");
    }
    return { intent: "internet_complaint", confidence: "high" };
  };

  const failed = await handleAgentMessage(
    conversationId,
    "Internet down",
    reply,
    classify,
  );
  assert.equal(failed.stage, "initial");

  const recovered = await handleAgentMessage(
    conversationId,
    "Internet down hai",
    reply,
    classify,
  );
  assert.equal(recovered.stage, "router_check");
  resetConversation(conversationId);
});

test("supports Roman Urdu answers through structured intents", async () => {
  const conversationId = "roman-urdu-classifier-test";
  resetConversation(conversationId);
  const intents = [
    "internet_complaint",
    "router_no_red_light",
    "restart_completed",
    "internet_not_working",
    "bill_paid",
    "payment_proof_sent",
  ] as const;
  let index = 0;
  const classify: IntentClassifier = async () => ({
    intent: intents[index++] ?? "unclear",
    confidence: "high",
  });

  await handleAgentMessage(conversationId, "Internet down hai", reply, classify);
  await handleAgentMessage(conversationId, "Sab green hain", reply, classify);
  await handleAgentMessage(conversationId, "Restart kar diya", reply, classify);
  await handleAgentMessage(conversationId, "Abhi bhi nahi chal raha", reply, classify);
  const paid = await handleAgentMessage(conversationId, "Bill paid hai", reply, classify);
  const proof = await handleAgentMessage(conversationId, "Screenshot bhej diya", reply, classify);

  assert.equal(paid.stage, "payment_proof");
  assert.equal(proof.stage, "ready_for_ticket");
  resetConversation(conversationId);
});

test("returns a clarification and does not advance for ambiguity", async () => {
  const conversationId = "ambiguous-classifier-test";
  resetConversation(conversationId);
  const result = await handleAgentMessage(
    conversationId,
    "I don't know",
    reply,
    async () => ({ intent: "unclear", confidence: "low" }),
  );

  assert.equal(result.stage, "initial");
  assert.match(result.reply, /did not understand/i);
  resetConversation(conversationId);
});

test("returns a safe retry message for classifier errors and invalid output", async () => {
  for (const [conversationId, classify] of [
    [
      "classifier-error-test",
      async () => {
        throw new Error("provider unavailable");
      },
    ],
    [
      "classifier-invalid-test",
      async () => ({ intent: "bill_paid", confidence: "invalid" } as never),
    ],
  ] as const) {
    resetConversation(conversationId);
    const result = await handleAgentMessage(conversationId, "yes", reply, classify);
    assert.equal(result.stage, "initial");
    assert.match(result.reply, /did not understand/i);
    resetConversation(conversationId);
  }
});

test("prevents an illegal stage transition", async () => {
  const conversationId = "illegal-transition-test";
  resetConversation(conversationId);
  await handleAgentMessage(
    conversationId,
    "Internet down",
    reply,
    classifierFor("internet_complaint"),
  );
  const result = await handleAgentMessage(
    conversationId,
    "Hello",
    reply,
    classifierFor("greeting"),
  );

  assert.equal(result.stage, "router_check");
  assert.match(result.reply, /did not understand/i);
  resetConversation(conversationId);
});
