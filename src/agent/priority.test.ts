import assert from "node:assert/strict";
import test from "node:test";
import { safeAssessment, validatePriorityAssessment } from "./priority.js";

test("uses a safe default when customer impact is unclear", () => {
  const result = safeAssessment({
    problemDescription: "Internet is not working",
    customerImpact: "Impact is unknown",
  });

  assert.equal(result.priority, "Normal");
  assert.ok(result.missingInformation.length > 0);
  assert.match(result.reason, /not sufficiently confirmed/i);
});

test("validates structured priority recommendations", () => {
  assert.equal(
    validatePriorityAssessment({
      priority: "High",
      reason: "Several customer locations are affected.",
      missingInformation: [],
    }),
    true,
  );
  assert.equal(
    validatePriorityAssessment({
      priority: "Urgent",
      reason: "",
      missingInformation: [],
    }),
    false,
  );
});
