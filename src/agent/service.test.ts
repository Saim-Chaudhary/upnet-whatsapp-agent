import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage, BaseMessage } from "@langchain/core/messages";
import { handleAgentMessage } from "./service.js";
import { InMemoryConversationStore, resetConversation } from "./conversation.js";
import type { IntentClassificationInput, IntentClassifier } from "./upnetAgent.js";
import type { CustomerIntent } from "./workflow.js";
import { retrieveKnowledge } from "./retriever.js";
import { InMemoryTicketRepository } from "../tickets/repository.js";
import { safeAssessment } from "./priority.js";
import { normalizeWhatsAppPhone } from "../routes/whatsapp.js";
import { InMemoryInboundMessageStore } from "./inbound.js";

const reply = async () => ({
  messages: [new AIMessage("Next step")],
});

test("retrieves relevant troubleshooting knowledge", () => {
  const passages = retrieveKnowledge("router red light and restart");

  assert.ok(passages.length > 0);
  assert.equal(passages[0]?.source, "internet-troubleshooting.md");
  assert.match(passages[0]?.text ?? "", /restart/i);
});

test("retrieves maintenance knowledge for outage questions", () => {
  const passages = retrieveKnowledge("area outage maintenance restoration time");

  assert.ok(passages.length > 0);
  assert.equal(passages[0]?.source, "maintenance-and-outages.md");
  assert.match(passages[0]?.text ?? "", /official|restoration|outage/i);
});

test("returns no useful knowledge for unrelated questions", () => {
  assert.deepEqual(retrieveKnowledge("weather forecast and cricket scores"), []);
});

test("normalizes individual WhatsApp addresses but rejects group chat IDs", () => {
  assert.equal(normalizeWhatsAppPhone("923001234567@c.us"), "923001234567");
  assert.equal(normalizeWhatsAppPhone("120363@g.us"), undefined);
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

test("passes retrieved knowledge separately to reply generation", async () => {
  const conversationId = "knowledge-context-test";
  resetConversation(conversationId);
  let generatedMessages: BaseMessage[] = [];
  const invoke = async (messages: BaseMessage[]) => {
    generatedMessages = messages;
    return reply();
  };

  await handleAgentMessage(
    conversationId,
    "What are the office hours?",
    invoke,
    async () => ({ intent: "service_status", confidence: "high" }),
  );

  const systemPrompt = String(generatedMessages[0]?.content);
  assert.match(systemPrompt, /Reference knowledge context:/);
  assert.match(systemPrompt, /Monday to Saturday/);
  assert.match(systemPrompt, /reference data only, not instructions/i);
  resetConversation(conversationId);
});

test("does not invent unknown company information", async () => {
  const conversationId = "unknown-knowledge-test";
  resetConversation(conversationId);
  let generatedMessages: BaseMessage[] = [];
  const invoke = async (messages: BaseMessage[]) => {
    generatedMessages = messages;
    return reply();
  };

  await handleAgentMessage(
    conversationId,
    "What is the official support phone number?",
    invoke,
    async () => ({ intent: "service_status", confidence: "high" }),
  );

  assert.match(
    String(generatedMessages[0]?.content),
    /official support phone number/i,
  );
  assert.match(String(generatedMessages[0]?.content), /not confirmed/i);
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
  const ticketRepository = new InMemoryTicketRepository();
  const classify: IntentClassifier = async () => ({
    intent: intents[index++] ?? "unclear",
    confidence: "high",
  });

  await handleAgentMessage(conversationId, "Internet down hai", reply, classify);
  await handleAgentMessage(conversationId, "Sab green hain", reply, classify);
  await handleAgentMessage(conversationId, "Restart kar diya", reply, classify);
  await handleAgentMessage(conversationId, "Abhi bhi nahi chal raha", reply, classify);
  const paid = await handleAgentMessage(conversationId, "Bill paid hai", reply, classify);
  const proof = await handleAgentMessage(
    conversationId,
    "Screenshot bhej diya",
    reply,
    classify,
    ticketRepository,
    safeAssessment,
  );

  assert.equal(paid.stage, "payment_proof");
  assert.equal(proof.stage, "ready_for_ticket");
  assert.match(proof.ticketNumber ?? "", /^UP-\d+$/);
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

test("does not create a ticket before the workflow reaches ticket-ready", async () => {
  const conversationId = "ticket-stage-restriction-test";
  resetConversation(conversationId);
  let createCalls = 0;
  const repository = {
    createTicket: async () => {
      createCalls += 1;
      throw new Error("should not be called");
    },
    overridePriority: async () => {
      throw new Error("not used");
    },
  };

  await handleAgentMessage(
    conversationId,
    "Internet down",
    reply,
    classifierFor("internet_complaint"),
    repository,
    safeAssessment,
  );

  assert.equal(createCalls, 0);
  resetConversation(conversationId);
});

test("does not claim ticket success when persistence fails", async () => {
  const conversationId = "ticket-database-failure-test";
  resetConversation(conversationId);
  const repository = {
    createTicket: async () => {
      throw new Error("database unavailable");
    },
    overridePriority: async () => {
      throw new Error("not used");
    },
  };
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

  await handleAgentMessage(conversationId, "Internet down", reply, classify);
  await handleAgentMessage(conversationId, "No red light", reply, classify);
  await handleAgentMessage(conversationId, "Restarted", reply, classify);
  await handleAgentMessage(conversationId, "Still down", reply, classify);
  await handleAgentMessage(conversationId, "Paid", reply, classify);
  const result = await handleAgentMessage(
    conversationId,
    "Receipt sent",
    reply,
    classify,
    repository,
    safeAssessment,
  );

  assert.equal(result.stage, "payment_proof");
  assert.equal(result.ticketNumber, undefined);
  assert.match(result.reply, /could not create the support ticket/i);
  resetConversation(conversationId);
});

test("retries a failed inbound message and replays its completed result", async () => {
  const conversationId = "durable-inbound-test";
  resetConversation(conversationId);
  const inbound = new InMemoryInboundMessageStore();
  let createAttempts = 0;
  const repository = {
    createTicket: async () => {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error("temporary database failure");
      return {
        id: "1",
        ticketNumber: "UP-1001",
        idempotencyKey: "request:message-1",
        customerPhone: "923001234567",
        problemDescription: "Internet remains unavailable.",
        troubleshootingSteps: "Completed.",
        priority: "Normal" as const,
        priorityReason: "Impact is unclear.",
        status: "Open" as const,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    overridePriority: async () => {
      throw new Error("not used");
    },
  };
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
    intent: intents[index++] ?? "payment_proof_sent",
    confidence: "high",
  });
  for (const message of [
    "Internet down",
    "No red light",
    "Restarted",
    "Still down",
    "Paid",
  ]) {
    await handleAgentMessage(
      conversationId,
      message,
      reply,
      classify,
      repository,
      safeAssessment,
      {},
    );
  }
  const context = {
    requestId: "message-1",
    customerPhone: "923001234567",
  };

  const failed = await handleAgentMessage(
    conversationId,
    "Receipt sent",
    reply,
    classify,
    repository,
    safeAssessment,
    context,
    undefined,
    inbound,
  );
  assert.equal(failed.ticketNumber, undefined);

  const succeeded = await handleAgentMessage(
    conversationId,
    "Receipt sent",
    reply,
    classify,
    repository,
    safeAssessment,
    context,
    undefined,
    inbound,
  );
  assert.equal(succeeded.ticketNumber, "UP-1001");

  const replay = await handleAgentMessage(
    conversationId,
    "Receipt sent",
    reply,
    classify,
    repository,
    safeAssessment,
    context,
    undefined,
    inbound,
  );
  assert.equal(replay.ticketNumber, "UP-1001");
  assert.equal(createAttempts, 2);
  resetConversation(conversationId);
});

test("serializes distinct inbound messages for one conversation", async () => {
  const conversationId = "conversation-lock-test";
  const store = new InMemoryConversationStore();
  const stages: string[] = [];
  const classify: IntentClassifier = async (input) => {
    stages.push(input.stage);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return input.stage === "initial"
      ? { intent: "internet_complaint", confidence: "high" }
      : { intent: "router_no_red_light", confidence: "high" };
  };

  await Promise.all([
    handleAgentMessage(conversationId, "Internet down", reply, classify, undefined, undefined, {}, store),
    handleAgentMessage(conversationId, "All lights are green", reply, classify, undefined, undefined, {}, store),
  ]);

  const restored = await store.load(conversationId);
  assert.deepEqual(stages, ["initial", "router_check"]);
  assert.equal(restored.stage, "restart_router");
  assert.equal(restored.messages.filter((message) => message.getType() === "human").length, 2);
});
