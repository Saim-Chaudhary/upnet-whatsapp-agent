import assert from "node:assert/strict";
import test from "node:test";
import { validateMaintenanceDraft } from "./repository.js";

const draft = {
  title: "Core switch maintenance",
  description: "Planned work on the aggregation switch.",
  affectedArea: "North exchange",
  severity: "Major" as const,
};

test("validates maintenance dates and required operational fields", () => {
  assert.doesNotThrow(() => validateMaintenanceDraft(draft));
  assert.throws(() => validateMaintenanceDraft({ ...draft, title: " " }), /title is required/);
  assert.throws(() => validateMaintenanceDraft({
    ...draft,
    plannedStartAt: new Date("2026-10-11T12:00:00Z"),
    plannedEndAt: new Date("2026-10-11T11:00:00Z"),
  }), /Planned end must be after planned start/);
});
