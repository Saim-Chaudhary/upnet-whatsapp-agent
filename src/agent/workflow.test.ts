import assert from "node:assert/strict";
import test from "node:test";
import { decideNextStep, detectIntent } from "./workflow.js";

test("keeps greetings in the initial stage", () => {
  for (const message of ["Hi", "Hello", "Assalam o Alaikum"]) {
    assert.equal(detectIntent(message), "greeting");
    assert.equal(decideNextStep("initial", message).nextStage, "initial");
  }
});

test("keeps out-of-scope messages in the initial stage", () => {
  const message = "What is the weather today?";

  assert.equal(detectIntent(message), "other");
  assert.equal(decideNextStep("initial", message).nextStage, "initial");
});

test("treats working internet as a resolved service-status case", () => {
  for (const message of [
    "Internet is working fine",
    "Mera net theek chal raha hai",
  ]) {
    assert.equal(detectIntent(message), "service_status");
    assert.equal(decideNextStep("initial", message).nextStage, "resolved");
  }
});

test("sends genuine internet complaints to router troubleshooting", () => {
  for (const message of [
    "Internet is not working",
    "Internet down",
    "Net nahi chal raha",
    "Internet slow hai",
  ]) {
    assert.equal(detectIntent(message), "internet_complaint");
    assert.equal(decideNextStep("initial", message).nextStage, "router_check");
  }
});

test("handles billing and payment-proof follow-ups", () => {
  assert.equal(
    decideNextStep("internet_status", "Still not working").nextStage,
    "billing_check",
  );
  assert.equal(
    decideNextStep("billing_check", "Bill paid hai").nextStage,
    "payment_proof",
  );
  assert.equal(
    decideNextStep("payment_proof", "I sent the payment screenshot").nextStage,
    "ready_for_ticket",
  );
});

test("gives neutral official-payment guidance for an unpaid bill", () => {
  const decision = decideNextStep("billing_check", "Bill not paid");

  assert.equal(decision.nextStage, "payment_required");
  assert.match(decision.instruction, /official UpNet payment method/i);
  assert.match(decision.instruction, /contact support again after payment/i);
  assert.match(decision.instruction, /Do not request payment proof/i);
  assert.match(decision.instruction, /Do not say .*definitely caused/i);
  assert.match(decision.instruction, /all troubleshooting must stop/i);
  assert.doesNotMatch(decision.instruction, /before troubleshooting can continue/i);
});

test("recognizes unrelated requests without starting troubleshooting", () => {
  assert.equal(detectIntent("Write Python code"), "other");
  assert.equal(decideNextStep("initial", "Write Python code").nextStage, "initial");
});

test("accepts no as a no-red-light answer and avoids repeating restart instructions", () => {
  assert.equal(decideNextStep("router_check", "No").nextStage, "restart_router");
  assert.equal(
    decideNextStep("restart_router", "Already restarted").nextStage,
    "internet_status",
  );
});

test("keeps unclear answers in the current stage", () => {
  for (const message of ["I don't know", "What do you mean?"]) {
    assert.equal(decideNextStep("router_check", message).nextStage, "router_check");
    assert.equal(decideNextStep("billing_check", message).nextStage, "billing_check");
  }
  assert.equal(
    decideNextStep("payment_proof", "I will send it later").nextStage,
    "payment_proof",
  );
});

test("covers English and Roman Urdu billing outcomes", () => {
  assert.equal(decideNextStep("billing_check", "Bill not paid").nextStage, "payment_required");
  assert.equal(decideNextStep("billing_check", "Bill paid hai").nextStage, "payment_proof");
  assert.equal(
    decideNextStep("payment_proof", "Screenshot bhej diya").nextStage,
    "ready_for_ticket",
  );
});
