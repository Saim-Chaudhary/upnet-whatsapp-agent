import assert from "node:assert/strict";
import test from "node:test";
import {
  decideNextStep,
  isClassifiedIntent,
  isIntentAllowedForStage,
} from "./workflow.js";

const classified = (intent: Parameters<typeof isIntentAllowedForStage>[1]) => ({
  intent,
  confidence: "high" as const,
});

test("allows valid initial intents and deterministic transitions", () => {
  assert.equal(decideNextStep("initial", classified("greeting")).nextStage, "initial");
  assert.equal(
    decideNextStep("initial", classified("internet_complaint")).nextStage,
    "router_check",
  );
  assert.equal(
    decideNextStep("initial", classified("service_status")).nextStage,
    "resolved",
  );
});

test("supports Roman Urdu stage-specific answers", () => {
  assert.equal(
    decideNextStep("router_check", classified("router_no_red_light")).nextStage,
    "restart_router",
  );
  assert.equal(
    decideNextStep("restart_router", classified("restart_completed")).nextStage,
    "internet_status",
  );
  assert.equal(
    decideNextStep("internet_status", classified("internet_not_working")).nextStage,
    "billing_check",
  );
  assert.equal(
    decideNextStep("billing_check", classified("bill_paid")).nextStage,
    "payment_proof",
  );
  assert.equal(
    decideNextStep("payment_proof", classified("payment_proof_sent")).nextStage,
    "ready_for_ticket",
  );
});

test("keeps unclear and illegal intents from advancing", () => {
  const unclear = decideNextStep("billing_check", classified("unclear"));
  const illegal = decideNextStep("billing_check", classified("greeting"));

  assert.equal(unclear.nextStage, "billing_check");
  assert.equal(illegal.nextStage, "billing_check");
  assert.match(unclear.instruction, /bill is paid/i);
  assert.match(illegal.instruction, /current question/i);
});

test("validates the structured classifier shape", () => {
  assert.equal(isClassifiedIntent(classified("bill_unpaid")), true);
  assert.equal(isClassifiedIntent({ intent: "bill_paid" }), false);
  assert.equal(isClassifiedIntent({ intent: "not-an-intent", confidence: "high" }), false);
});
