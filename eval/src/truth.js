export const TRUTH_SOURCES = new Set(["labeled", "seeded", "verdict", "user_miss"]);
export const SEVERITIES = new Set(["low", "medium", "high"]);

export function normalizeTruth(raw = {}, { page = null, source = "labeled" } = {}) {
  const pageId = text(raw.page) || page?.pageId || "";
  return {
    ...raw,
    exhaustive: Boolean(raw.exhaustive),
    findings: normalizeFindings(raw.findings, { defaultSource: source }),
    geometry_output_hash: text(raw.geometry_output_hash ?? raw.geometryOutputHash),
    geometry_source_hash: text(raw.geometry_source_hash ?? raw.geometrySourceHash),
    known_false_positives: normalizeFindings(
      raw.known_false_positives ?? raw.knownFalsePositives,
      { defaultSource: "verdict", requireGtId: false },
    ),
    labeled_at: text(raw.labeled_at ?? raw.labeledAt),
    labeler: text(raw.labeler),
    page: pageId,
    sheet_file: text(raw.sheet_file ?? raw.sheetFile),
  };
}

export function normalizeTruthFinding(
  raw = {},
  { defaultSource = "labeled", requireGtId = true } = {},
) {
  const source = text(raw.source) || defaultSource;
  return {
    ...raw,
    gt_id: text(raw.gt_id ?? raw.gtId) || (requireGtId ? "" : text(raw.fp_id ?? raw.fpId)),
    measure_number: nullablePositiveInt(raw.measure_number ?? raw.measure),
    note: text(raw.note),
    rule_id: text(raw.rule_id ?? raw.rule),
    severity: normalizeSeverity(raw.severity),
    source: TRUTH_SOURCES.has(source) ? source : "",
    staff_label: nullableText(raw.staff_label ?? raw.staff),
    suppressed: Boolean(raw.suppressed),
    system_number: positiveInt(raw.system_number ?? raw.system),
  };
}

export function normalizeSeverity(value) {
  const severity = text(value).toLowerCase();
  if (SEVERITIES.has(severity)) return severity;
  if (severity === "error") return "high";
  if (severity === "warning") return "medium";
  if (severity === "suggestion") return "low";
  return "";
}

function normalizeFindings(value, options) {
  return Array.isArray(value)
    ? value.map((finding) => normalizeTruthFinding(finding, options))
    : [];
}

function positiveInt(value) {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nullablePositiveInt(value) {
  if (value === null || value === undefined || value === "") return null;
  return positiveInt(value);
}

function nullableText(value) {
  const valueText = text(value);
  return valueText || null;
}

function text(value) {
  return String(value ?? "").trim();
}
