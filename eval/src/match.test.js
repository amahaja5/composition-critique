import assert from "node:assert/strict";
import { computeEvalResults } from "./metrics.js";
import { matchPage, measureCompatibilityScore } from "./match.js";

assert.equal(measureCompatibilityScore(4, 4), 3);
assert.equal(measureCompatibilityScore(4, 5), 2);
assert.equal(measureCompatibilityScore(null, 5), 1);
assert.equal(measureCompatibilityScore(2, 5), 0);

let result = matchPage({
  predictions: [{ rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" }],
  truth: {
    exhaustive: true,
    findings: [{ gt_id: "p1-1", rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" }],
  },
});
assert.equal(result.matches.length, 1);
assert.equal(result.falsePositives.length, 0);
assert.equal(result.falseNegatives.length, 0);
assert.equal(result.matches[0].measure_match, "exact");

result = matchPage({
  predictions: [
    { rule_id: "DYN-05", system_number: 1, measure_number: 5, severity: "medium" },
    { rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" },
  ],
  truth: {
    exhaustive: true,
    findings: [{ gt_id: "p1-1", rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" }],
  },
});
assert.equal(result.matches.length, 1);
assert.equal(result.matches[0].measure_match, "exact");
assert.equal(result.falsePositives.length, 1);

result = matchPage({
  predictions: [{ rule_id: "DYN-05", system_number: 1, measure_number: 5, severity: "medium" }],
  truth: {
    exhaustive: true,
    findings: [{ gt_id: "p1-1", rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" }],
  },
});
assert.equal(result.matches.length, 1);
assert.equal(result.matches[0].measure_match, "adjacent");

result = matchPage({
  predictions: [{ rule_id: "DYN-05", system_number: 1, measure_number: 5, severity: "medium" }],
  truth: {
    exhaustive: true,
    findings: [{ gt_id: "p1-1", rule_id: "DYN-05", system_number: 1, measure_number: null, severity: "medium" }],
  },
});
assert.equal(result.matches.length, 1);
assert.equal(result.matches[0].measure_match, "null_compatible");

result = matchPage({
  predictions: [
    { rule_id: "TEXT-11", system_number: 1, measure_number: 1, severity: "medium" },
  ],
  truth: {
    exhaustive: true,
    findings: [
      { gt_id: "ignore-1", rule_id: "IGNORE", system_number: 1, measure_number: 1, severity: "low" },
    ],
  },
});
assert.equal(result.dropped_predictions, 1);
assert.equal(result.falsePositives.length, 0);

result = matchPage({
  predictions: [{ rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" }],
  truth: {
    exhaustive: true,
    findings: [
      { gt_id: "p1-1", rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium", suppressed: true },
    ],
  },
});
assert.equal(result.suppressedHits.length, 1);
assert.equal(result.matches.length, 0);
assert.equal(result.falsePositives.length, 0);

result = matchPage({
  predictions: [{ rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" }],
  truth: {
    exhaustive: false,
    findings: [],
    known_false_positives: [
      { rule_id: "DYN-05", system_number: 1, measure_number: 4, staff_label: null },
    ],
  },
});
assert.equal(result.confirmedFalsePositives.length, 1);
assert.equal(result.unverified.length, 0);

result = matchPage({
  predictions: [{ rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" }],
  truth: {
    exhaustive: false,
    findings: [],
    known_false_positives: [],
  },
});
assert.equal(result.falsePositives.length, 0);
assert.equal(result.unverified.length, 1);

result = matchPage({
  predictions: [{ rule_id: "DYN-05", system_number: 2, measure_number: 4, severity: "medium" }],
  truth: {
    exhaustive: true,
    findings: [{ gt_id: "p1-1", rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" }],
  },
});
assert.equal(result.nearMisses[0].kind, "right_rule_wrong_system");

result = matchPage({
  predictions: [{ rule_id: "DYN-05", system_number: 1, measure_number: 4, severity: "medium" }],
  truth: {
    exhaustive: true,
    findings: [{ gt_id: "p1-1", rule_id: "TEXT-11", system_number: 1, measure_number: 4, severity: "medium" }],
  },
});
assert.equal(result.nearMisses[0].kind, "right_location_wrong_rule");

const metrics = computeEvalResults([
  {
    pageId: "p1",
    predictions: [{ rule_id: "TEXT-11", system_number: 1, measure_number: 1, severity: "medium" }],
    source: "golden",
    truth: {
      exhaustive: true,
      findings: [
        { gt_id: "miss-1", rule_id: "TEXT-11", system_number: 1, measure_number: 1, severity: "medium", source: "user_miss" },
      ],
      known_false_positives: [],
    },
  },
  {
    pageId: "p2",
    predictions: [{ rule_id: "DYN-05", system_number: 1, measure_number: 1, severity: "medium" }],
    source: "golden",
    truth: {
      exhaustive: false,
      findings: [
        { gt_id: "supp-1", rule_id: "DYN-05", system_number: 1, measure_number: 1, severity: "medium", suppressed: true },
      ],
      known_false_positives: [],
    },
  },
]);
assert.equal(metrics.sections.regression.user_miss_recall, 1);
assert.equal(metrics.sections.partial_feedback.irrelevance_rate, 1);

console.log("Eval matching tests passed.");
