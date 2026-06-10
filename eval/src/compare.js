import { writeFile } from "node:fs/promises";
import path from "node:path";

import { csvEscape, formatRate, parseArgs, paths, readJson } from "./common.js";

const args = parseArgs();
const [baseRunId, nextRunId] = args._;

if (!baseRunId || !nextRunId) {
  throw new Error("Usage: npm run eval:compare -- <baselineRunId> <experimentRunId>");
}

const baseConfig = await readJson(path.join(paths.runs, baseRunId, "config.json"));
const nextConfig = await readJson(path.join(paths.runs, nextRunId, "config.json"));
const base = await readJson(path.join(paths.runs, baseRunId, "results.json"));
const next = await readJson(path.join(paths.runs, nextRunId, "results.json"));
const baseRules = new Map(base.perRule.map((row) => [row.rule_id, row]));
const nextRules = new Map(next.perRule.map((row) => [row.rule_id, row]));
const ruleIds = [...new Set([...baseRules.keys(), ...nextRules.keys()])].sort();

const markdown = [
  `# Eval Compare: ${baseRunId} -> ${nextRunId}`,
  "",
  "## Config Diff",
  "",
  `- Baseline model: ${baseConfig.model ?? "unknown"}`,
  `- Experiment model: ${nextConfig.model ?? "unknown"}`,
  `- Baseline prompt hash: ${baseConfig.prompt_hash ?? "unknown"}`,
  `- Experiment prompt hash: ${nextConfig.prompt_hash ?? "unknown"}`,
  `- Baseline registry version: ${baseConfig.registry_version ?? "unknown"}`,
  `- Experiment registry version: ${nextConfig.registry_version ?? "unknown"}`,
  "",
  "## Section Delta",
  "",
  "| Section | Metric | Baseline | Experiment | Delta |",
  "| --- | --- | ---: | ---: | ---: |",
  ...sectionDeltaRows(),
  "",
  "## Per Rule Delta",
  "",
  "| Rule | Base n | Next n | Precision Δ | Recall Δ | F1 Δ |",
  "| --- | ---: | ---: | ---: | ---: | ---: |",
  ...ruleIds.map((ruleId) => {
    const before = baseRules.get(ruleId) ?? {};
    const after = nextRules.get(ruleId) ?? {};
    return [
      `\`${ruleId}\``,
      (before.tp ?? 0) + (before.fn ?? 0),
      (after.tp ?? 0) + (after.fn ?? 0),
      formatDelta(after.precision, before.precision),
      formatDelta(after.recall, before.recall),
      formatDelta(after.f1, before.f1),
    ].join(" | ");
  }),
  "",
].join("\n");

const outBase = `${baseRunId}_vs_${nextRunId}`;
await writeFile(path.join(paths.report, `${outBase}.md`), markdown);
await writeFile(path.join(paths.report, `${outBase}.csv`), renderCsv());
console.log(markdown);

function renderCsv() {
  const rows = [
    ["section", "rule_id", "base_n", "next_n", "precision_delta", "recall_delta", "f1_delta"],
    ...sectionDeltaRows().map((line) => {
      const [section, metric, before, after, delta] = line.split(" | ");
      return [section, metric, "", "", before, after, delta];
    }),
    ...ruleIds.map((ruleId) => {
      const before = baseRules.get(ruleId) ?? {};
      const after = nextRules.get(ruleId) ?? {};
      return [
        "exhaustive_golden_rule",
        ruleId,
        (before.tp ?? 0) + (before.fn ?? 0),
        (after.tp ?? 0) + (after.fn ?? 0),
        numericDelta(after.precision, before.precision),
        numericDelta(after.recall, before.recall),
        numericDelta(after.f1, before.f1),
      ];
    }),
  ];
  return `${rows.map((row) => row.map(csvEscape).join(",")).join("\n")}\n`;
}

function sectionDeltaRows() {
  const sections = [
    ["exhaustive_golden", ["precision", "recall", "f1", "localization_accuracy", "severity_agreement"]],
    ["partial_feedback", ["confirmed_precision", "confirmed_fp_rate", "irrelevance_rate"]],
    ["regression", ["user_miss_recall", "known_fp_silence_rate"]],
    ["seeded", ["precision", "recall", "f1"]],
  ];
  return sections.flatMap(([section, metrics]) =>
    metrics.map((metric) => {
      const before = base.sections?.[section] ?? {};
      const after = next.sections?.[section] ?? {};
      return [
        section,
        metric,
        formatRate(before[metric]),
        formatRate(after[metric]),
        formatDelta(after[metric], before[metric]),
      ].join(" | ");
    }),
  );
}

function numericDelta(after, before) {
  return Number.isFinite(after) && Number.isFinite(before) ? after - before : "";
}

function formatDelta(after, before) {
  const delta = numericDelta(after, before);
  return typeof delta === "number" ? `${delta >= 0 ? "+" : ""}${delta.toFixed(3)}` : "n/a";
}
