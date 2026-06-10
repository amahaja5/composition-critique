import path from "node:path";

import { detectScoreGeometryFromPixels } from "../../src/lib/scoreGeometry.js";
import { loadGoldenPageRecords, loadTruthRecords } from "./dataset.js";
import { pathExists } from "./common.js";
import { readPngPixels } from "./png.js";
import { loadRuleRegistry } from "./rules.js";
import { TRUTH_SOURCES } from "./truth.js";

const rules = await loadRuleRegistry();
const pageRecords = await loadGoldenPageRecords();
const truthRecords = await loadTruthRecords({ includeSeeded: true });
const errors = [];
const warnings = [];

for (const page of pageRecords) {
  if (!(await pathExists(page.file))) {
    errors.push(`Manifest page ${page.pageId} is missing PNG ${path.basename(page.file)}.`);
  }
}

for (const { page, truth, truthFile } of truthRecords) {
  validateTruthEnvelope({ page, truth, truthFile });
  if (await pathExists(page.file)) {
    const geometry = await geometryForPng(page.file);
    validateFindingsAgainstGeometry({ geometry, page, truth, truthFile });
  } else {
    errors.push(`${truthFile}: missing page PNG ${page.file}.`);
  }
}

if (!truthRecords.length) {
  warnings.push("No truth files found yet.");
}

for (const warning of warnings) {
  console.warn(`[eval:validate] ${warning}`);
}

if (errors.length) {
  for (const error of errors) {
    console.error(`[eval:validate] ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Validated ${truthRecords.length} truth file${truthRecords.length === 1 ? "" : "s"}.`);
}

function validateTruthEnvelope({ page, truth, truthFile }) {
  if (truth.page !== page.pageId) {
    errors.push(`${truthFile}: page must be ${page.pageId}.`);
  }
  if (!truth.labeler && page.source !== "seeded") {
    errors.push(`${truthFile}: labeler is required.`);
  }
  if (!truth.labeled_at && page.source !== "seeded") {
    errors.push(`${truthFile}: labeled_at is required.`);
  }
  if (typeof truth.exhaustive !== "boolean") {
    errors.push(`${truthFile}: exhaustive must be true or false.`);
  }
  if (!Array.isArray(truth.findings)) {
    errors.push(`${truthFile}: findings must be an array.`);
    return;
  }
  if (!Array.isArray(truth.known_false_positives)) {
    errors.push(`${truthFile}: known_false_positives must be an array.`);
  }

  const gtIds = new Set();
  for (const [index, finding] of truth.findings.entries()) {
    const label = `${truthFile}: finding ${index + 1}`;
    validateScoringEntry({
      entry: finding,
      label,
      requireSeverity: true,
      requireGtId: true,
    });
    if (gtIds.has(finding.gt_id)) errors.push(`${label}: duplicate gt_id ${finding.gt_id}.`);
    gtIds.add(finding.gt_id);
    if (typeof finding.suppressed !== "boolean") errors.push(`${label}: suppressed must be true or false.`);
    if (!TRUTH_SOURCES.has(finding.source)) errors.push(`${label}: source must be labeled, seeded, verdict, or user_miss.`);
  }

  for (const [index, finding] of truth.known_false_positives.entries()) {
    validateScoringEntry({
      entry: finding,
      label: `${truthFile}: known_false_positives ${index + 1}`,
      requireSeverity: false,
      requireGtId: false,
    });
  }
}

function validateFindingsAgainstGeometry({ geometry, page, truth, truthFile }) {
  if (page.expectedSystems && page.expectedSystems !== geometry.systems.length) {
    warnings.push(
      `${truthFile}: expected ${page.expectedSystems} systems, geometry detects ${geometry.systems.length}.`,
    );
  }
  for (const [index, finding] of [
    ...truth.findings.map((finding, findingIndex) => ({
      finding,
      label: `${truthFile}: finding ${findingIndex + 1}`,
    })),
    ...truth.known_false_positives.map((finding, findingIndex) => ({
      finding,
      label: `${truthFile}: known_false_positives ${findingIndex + 1}`,
    })),
  ].entries()) {
    void index;
    const { label } = finding;
    const entry = finding.finding;
    const system = geometry.systems[Number(entry.system_number) - 1];
    if (!system) {
      errors.push(`${label}: system_number ${entry.system_number} exceeds detected system count ${geometry.systems.length}.`);
      continue;
    }
    if (entry.measure_number && !system.measures) {
      errors.push(`${label}: system ${entry.system_number} has no detected measure ticks; use measure_number null.`);
    } else if (
      entry.measure_number &&
      system.measures &&
      Number(entry.measure_number) > system.measures.length
    ) {
      errors.push(`${label}: measure_number ${entry.measure_number} exceeds detected measure count ${system.measures.length}.`);
    }
  }
}

function validateScoringEntry({ entry, label, requireGtId, requireSeverity }) {
  if (requireGtId && !entry.gt_id) errors.push(`${label}: gt_id is required.`);
  if (!rules.has(entry.rule_id)) {
    errors.push(`${label}: unknown rule_id ${entry.rule_id}.`);
  }
  if (requireSeverity && !["low", "medium", "high"].includes(String(entry.severity ?? ""))) {
    errors.push(`${label}: severity must be low, medium, or high.`);
  }
  if (!positiveInt(entry.system_number)) {
    errors.push(`${label}: system_number must be a positive integer.`);
  }
  if (
    entry.measure_number !== null &&
    entry.measure_number !== undefined &&
    !positiveInt(entry.measure_number)
  ) {
    errors.push(`${label}: measure_number must be null or a positive integer.`);
  }
}

async function geometryForPng(file) {
  const { data, height, width } = await readPngPixels(file);
  return detectScoreGeometryFromPixels({
    data,
    height,
    width,
  });
}

function positiveInt(value) {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) && number > 0;
}
