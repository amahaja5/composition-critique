import { csvEscape, formatRate } from "./common.js";
import { matchPage } from "./match.js";

export function computeEvalResults(pageResults) {
  const pages = pageResults.map((page) => {
    const match = matchPage({
      predictions: page.predictions,
      truth: page.truth,
    });
    return {
      ...page,
      match,
      summary: summarizeCounts(match),
    };
  });
  const exhaustiveGolden = pages.filter((page) => page.source !== "seeded" && page.truth.exhaustive);
  const partialAndFeedback = pages.filter(
    (page) =>
      page.source !== "seeded" &&
      (!page.truth.exhaustive ||
        page.match.confirmedFalsePositives.length ||
        page.match.suppressedHits.length),
  );
  const seeded = pages.filter((page) => page.source === "seeded");

  return {
    pages,
    perRule: summarizePerRule(exhaustiveGolden),
    sections: {
      exhaustive_golden: summarizeGroup(exhaustiveGolden),
      partial_feedback: summarizePartialFeedback(partialAndFeedback),
      regression: summarizeRegression(pages),
      seeded: summarizeGroup(seeded),
    },
  };
}

export function renderMarkdownReport({ config = {}, results, runId }) {
  const lines = [
    `# Engraving Eval Report: ${runId}`,
    "",
    "## Config",
    "",
    `- Model: ${config.model ?? "unknown"}`,
    `- Prompt hash: ${config.prompt_hash ?? "unknown"}`,
    `- Registry version: ${config.registry_version ?? "unknown"}`,
    `- Label: ${config.label ?? "n/a"}`,
    `- Created: ${config.created_at ?? "n/a"}`,
    "",
    "## A. Exhaustive Golden Pages",
    "",
    renderMetricTable([["headline", results.sections.exhaustive_golden]]),
    "",
    "## B. Partial Pages And Feedback",
    "",
    renderPartialFeedbackTable(results.sections.partial_feedback),
    "",
    "## C. Regression Subsets",
    "",
    renderRegressionTable(results.sections.regression),
    "",
    "## Seeded Pages",
    "",
    renderMetricTable([["seeded", results.sections.seeded]]),
    "",
    "## Per Rule: Exhaustive Golden",
    "",
    "| Rule | TP | FP | FN | Precision | Recall | F1 | Severity agreement |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.perRule.map((row) =>
      [
        `\`${row.rule_id}\``,
        row.tp,
        row.fp,
        row.fn,
        formatRate(row.precision),
        formatRate(row.recall),
        formatRate(row.f1),
        formatRate(row.severity_agreement),
      ].join(" | "),
    ),
    "",
    "## Worst Pages",
    "",
    "| Page | Source | TP | FP | FN | Confirmed FP | Suppressed | Unverified | Precision | Recall | Near misses |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...[...results.pages]
      .sort((a, b) => pageBadness(b.summary) - pageBadness(a.summary))
      .map((page) =>
        [
          page.pageId,
          page.source,
          page.summary.tp,
          page.summary.fp,
          page.summary.fn,
          page.summary.confirmed_fp,
          page.summary.suppressed_hits,
          page.summary.unverified,
          formatRate(page.summary.precision),
          formatRate(page.summary.recall),
          page.match.nearMisses.length,
        ].join(" | "),
      ),
    "",
    "## Near Misses",
    "",
    "| Page | Kind | Prediction | Truth |",
    "| --- | --- | --- | --- |",
    ...results.pages.flatMap((page) =>
      page.match.nearMisses.map((miss) =>
        [
          page.pageId,
          miss.kind,
          describeFinding(miss.prediction),
          describeFinding(miss.truth),
        ].join(" | "),
      ),
    ),
    "",
  ];
  return lines.join("\n");
}

export function renderCsvReport(results) {
  const rows = [
    [
      "section",
      "page",
      "source",
      "rule_id",
      "tp",
      "fp",
      "fn",
      "confirmed_fp",
      "suppressed_hits",
      "unverified",
      "precision",
      "recall",
      "f1",
      "severity_agreement",
    ],
    ...results.perRule.map((row) => [
      "exhaustive_golden_rule",
      "",
      "golden",
      row.rule_id,
      row.tp,
      row.fp,
      row.fn,
      row.confirmed_fp,
      row.suppressed_hits,
      row.unverified,
      formatRate(row.precision),
      formatRate(row.recall),
      formatRate(row.f1),
      formatRate(row.severity_agreement),
    ]),
    ...results.pages.map((page) => [
      "page",
      page.pageId,
      page.source,
      "",
      page.summary.tp,
      page.summary.fp,
      page.summary.fn,
      page.summary.confirmed_fp,
      page.summary.suppressed_hits,
      page.summary.unverified,
      formatRate(page.summary.precision),
      formatRate(page.summary.recall),
      formatRate(page.summary.f1),
      formatRate(page.summary.severity_agreement),
    ]),
  ];
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function summarizePerRule(pages) {
  const ruleIds = new Set();
  for (const page of pages) {
    for (const match of page.match.matches) ruleIds.add(match.truth.rule_id);
    for (const finding of page.match.falsePositives) ruleIds.add(finding.rule_id);
    for (const finding of page.match.falseNegatives) ruleIds.add(finding.rule_id);
    for (const match of page.match.confirmedFalsePositives) ruleIds.add(match.truth.rule_id);
  }

  return [...ruleIds].sort().map((ruleId) => {
    const pseudoPages = pages.map((page) => ({
      match: {
        confirmedFalsePositives: page.match.confirmedFalsePositives.filter((match) => match.truth.rule_id === ruleId),
        falseNegatives: page.match.falseNegatives.filter((finding) => finding.rule_id === ruleId),
        falsePositives: page.match.falsePositives.filter((finding) => finding.rule_id === ruleId),
        matches: page.match.matches.filter((match) => match.truth.rule_id === ruleId),
        suppressedHits: page.match.suppressedHits.filter((match) => match.truth.rule_id === ruleId),
        unverified: page.match.unverified.filter((finding) => finding.rule_id === ruleId),
      },
    }));
    return { rule_id: ruleId, ...summarizeGroup(pseudoPages) };
  });
}

function summarizePartialFeedback(pages) {
  const counts = pages.reduce(
    (acc, page) => addCounts(acc, summarizeCounts(page.match)),
    emptyCounts(),
  );
  const correct = counts.tp + counts.suppressed_hits;
  return {
    ...finalizeCounts(counts),
    confirmed_fp_rate:
      counts.tp + counts.confirmed_fp ? counts.confirmed_fp / (counts.tp + counts.confirmed_fp) : null,
    confirmed_precision:
      counts.tp + counts.confirmed_fp ? counts.tp / (counts.tp + counts.confirmed_fp) : null,
    irrelevance_rate: correct ? counts.suppressed_hits / correct : null,
  };
}

function summarizeRegression(pages) {
  let userMissRecovered = 0;
  let userMissTotal = 0;
  let knownFpHit = 0;
  let knownFpTotal = 0;

  for (const page of pages) {
    const userMissIds = new Set(
      page.truth.findings
        .filter((finding) => finding.source === "user_miss" && finding.rule_id !== "IGNORE")
        .map((finding) => finding.gt_id),
    );
    userMissTotal += userMissIds.size;
    for (const match of page.match.matches) {
      if (userMissIds.has(match.truth.gt_id)) userMissRecovered += 1;
    }

    knownFpTotal += page.truth.known_false_positives?.length ?? 0;
    knownFpHit += page.match.confirmedFalsePositives.length;
  }

  return {
    known_fp_hit: knownFpHit,
    known_fp_silence_rate: knownFpTotal ? (knownFpTotal - knownFpHit) / knownFpTotal : null,
    known_fp_silent: knownFpTotal - knownFpHit,
    known_fp_total: knownFpTotal,
    user_miss_recall: userMissTotal ? userMissRecovered / userMissTotal : null,
    user_miss_recovered: userMissRecovered,
    user_miss_total: userMissTotal,
  };
}

function summarizeGroup(pages) {
  const counts = pages.reduce(
    (acc, page) => addCounts(acc, summarizeCounts(page.match)),
    emptyCounts(),
  );
  return finalizeCounts(counts);
}

function summarizeCounts(match) {
  const counts = emptyCounts();
  counts.confirmed_fp = match.confirmedFalsePositives.length;
  counts.fn = match.falseNegatives.length;
  counts.fp = match.falsePositives.length + match.confirmedFalsePositives.length;
  counts.suppressed_hits = match.suppressedHits.length;
  counts.tp = match.matches.length;
  counts.unverified = match.unverified.length;
  counts.exact_measure = match.matches.filter((item) => item.measure_match === "exact").length;
  counts.severity_matches = match.matches.filter((item) => item.severity_match).length;
  return finalizeCounts(counts);
}

function emptyCounts() {
  return {
    confirmed_fp: 0,
    exact_measure: 0,
    fn: 0,
    fp: 0,
    severity_matches: 0,
    suppressed_hits: 0,
    tp: 0,
    unverified: 0,
  };
}

function addCounts(left, right) {
  return {
    confirmed_fp: left.confirmed_fp + right.confirmed_fp,
    exact_measure: left.exact_measure + right.exact_measure,
    fn: left.fn + right.fn,
    fp: left.fp + right.fp,
    severity_matches: left.severity_matches + right.severity_matches,
    suppressed_hits: left.suppressed_hits + right.suppressed_hits,
    tp: left.tp + right.tp,
    unverified: left.unverified + right.unverified,
  };
}

function finalizeCounts(counts) {
  const precision = counts.tp + counts.fp ? counts.tp / (counts.tp + counts.fp) : null;
  const recall = counts.tp + counts.fn ? counts.tp / (counts.tp + counts.fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall
      ? (2 * precision * recall) / (precision + recall)
      : null;
  return {
    ...counts,
    f1,
    localization_accuracy: counts.tp ? counts.exact_measure / counts.tp : null,
    precision,
    recall,
    severity_agreement: counts.tp ? counts.severity_matches / counts.tp : null,
  };
}

function renderMetricTable(rows) {
  return [
    "| Set | TP | FP | FN | Precision | Recall | F1 | Localization exact | Severity agreement |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows.map(([label, row]) =>
      [
        label,
        row.tp,
        row.fp,
        row.fn,
        formatRate(row.precision),
        formatRate(row.recall),
        formatRate(row.f1),
        formatRate(row.localization_accuracy),
        formatRate(row.severity_agreement),
      ].join(" | "),
    ),
  ].join("\n");
}

function renderPartialFeedbackTable(row) {
  return [
    "| TP | Confirmed FP | Suppressed hits | Unverified | Confirmed precision | Confirmed FP rate | Irrelevance rate |",
    "| ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    [
      row.tp,
      row.confirmed_fp,
      row.suppressed_hits,
      row.unverified,
      formatRate(row.confirmed_precision),
      formatRate(row.confirmed_fp_rate),
      formatRate(row.irrelevance_rate),
    ].join(" | "),
  ].join("\n");
}

function renderRegressionTable(row) {
  return [
    "| User-miss recovered | User-miss total | User-miss recall | Known-FP silent | Known-FP total | Known-FP silence rate |",
    "| ---: | ---: | ---: | ---: | ---: | ---: |",
    [
      row.user_miss_recovered,
      row.user_miss_total,
      formatRate(row.user_miss_recall),
      row.known_fp_silent,
      row.known_fp_total,
      formatRate(row.known_fp_silence_rate),
    ].join(" | "),
  ].join("\n");
}

function pageBadness(summary) {
  return summary.fp + summary.fn + summary.confirmed_fp + (summary.precision === null ? 0 : 1 - summary.precision);
}

function describeFinding(finding) {
  return [
    finding.rule_id,
    `S${finding.system_number ?? "?"}`,
    finding.measure_number ? `m${finding.measure_number}` : "m?",
  ].join(" ");
}
