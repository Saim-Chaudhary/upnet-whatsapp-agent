import assert from "node:assert/strict";
import test from "node:test";
import { AIMessage } from "@langchain/core/messages";
import { handleAgentMessage } from "./service.js";
import { resetConversation } from "./conversation.js";

test("keeps local messages in one conversation and advances the workflow", async () => {
  const conversationId = "local-service-test";
  resetConversation(conversationId);
  const seen: string[][] = [];

  const reply = async (messages: import("@langchain/core/messages").BaseMessage[]) => {
    seen.push(messages.map((message) => String(message.content)));
    return { messages: [new AIMessage("Please restart your router and confirm when done.")] };
  };

  const first = await handleAgentMessage(
    conversationId,
    "Internet nahi chal raha",
    reply,
  );
  const second = await handleAgentMessage(conversationId, "All lights green hain", reply);

  assert.equal(first.stage, "router_check");
  assert.equal(second.stage, "restart_router");
  assert.equal(second.reply, "Please restart your router and confirm when done.");
  assert.equal(seen[1]?.some((message) => message.includes("Internet nahi chal raha")), true);
  resetConversation(conversationId);
});

test("supports a Roman Urdu restart follow-up", async () => {
  const conversationId = "local-restart-test";
  resetConversation(conversationId);
  const reply = async () => ({ messages: [new AIMessage("Internet working now?")] });

  await handleAgentMessage(conversationId, "Internet down hai", reply);
  await handleAgentMessage(conversationId, "All lights green hain", reply);
  const result = await handleAgentMessage(conversationId, "restart kar diya", reply);

  assert.equal(result.stage, "internet_status");
  resetConversation(conversationId);
});

test("moves from restart failure to billing without repeating the status question", async () => {
  const conversationId = "local-billing-flow-test";
  resetConversation(conversationId);
  const instructions: string[] = [];
  const reply = async (messages: import("@langchain/core/messages").BaseMessage[]) => {
    instructions.push(String(messages[0]?.content));
    return { messages: [new AIMessage("Next step")] };
  };

  await handleAgentMessage(conversationId, "Internet nahi chal raha", reply);
  await handleAgentMessage(conversationId, "All lights green hain", reply);
  await handleAgentMessage(conversationId, "Already restarted", reply);
  await handleAgentMessage(conversationId, "Still not working", reply);

  assert.match(instructions[3] ?? "", /bill is paid/i);
  assert.doesNotMatch(instructions[3] ?? "", /ask whether the internet is working/i);
  resetConversation(conversationId);
});

test("handles paid and unpaid billing outcomes honestly", async () => {
  const paidConversation = "local-paid-flow-test";
  const unpaidConversation = "local-unpaid-flow-test";
  resetConversation(paidConversation);
  resetConversation(unpaidConversation);
  const instructions: string[] = [];
  const reply = async (messages: import("@langchain/core/messages").BaseMessage[]) => {
    instructions.push(String(messages[0]?.content));
    return { messages: [new AIMessage("Acknowledged")] };
  };

  await handleAgentMessage(paidConversation, "Internet down hai", reply);
  await handleAgentMessage(paidConversation, "All lights green hain", reply);
  await handleAgentMessage(paidConversation, "Already restarted", reply);
  await handleAgentMessage(paidConversation, "Still not working", reply);
  const paid = await handleAgentMessage(paidConversation, "Bill paid hai", reply);
  const proof = await handleAgentMessage(
    paidConversation,
    "Payment screenshot bhej diya",
    reply,
  );
  await handleAgentMessage(unpaidConversation, "Internet down hai", reply);
  await handleAgentMessage(unpaidConversation, "All lights green hain", reply);
  await handleAgentMessage(unpaidConversation, "Already restarted", reply);
  await handleAgentMessage(unpaidConversation, "Still not working", reply);
  const unpaid = await handleAgentMessage(unpaidConversation, "Bill not paid", reply);

  assert.equal(paid.stage, "payment_proof");
  assert.equal(proof.stage, "ready_for_ticket");
  assert.equal(unpaid.stage, "payment_required");
  const unpaidInstruction = instructions.at(-1) ?? "";
  assert.match(unpaidInstruction, /official UpNet payment method/i);
  assert.match(unpaidInstruction, /contact support again after payment/i);
  assert.doesNotMatch(
    unpaidInstruction,
    /ask (the customer )?(to )?(send|provide).*proof/i,
  );
  assert.match(
    unpaidInstruction,
    /Do not say that the unpaid bill definitely caused the internet issue/i,
  );
  assert.match(
    unpaidInstruction,
    /or that all troubleshooting must stop/i,
  );
  assert.match(
    instructions.find((instruction) => instruction.includes("not available in this chat yet")) ?? "",
    /not available in this chat yet/i,
  );
  resetConversation(paidConversation);
  resetConversation(unpaidConversation);
});
