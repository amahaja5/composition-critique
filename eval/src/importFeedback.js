import { createClient } from "@supabase/supabase-js";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ensureDir,
  parseArgs,
  pathExists,
  paths,
  readJson,
  writeJson,
} from "./common.js";
import { loadGoldenPageRecords } from "./dataset.js";
import { normalizeTruth } from "./truth.js";

const args = parseArgs();
const dryRun = Boolean(args.dryRun);
const supabaseUrl = process.env.VITE_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if ((!supabaseUrl || !serviceRoleKey) && dryRun) {
  console.log("[eval:import-feedback] Supabase env missing; dry run has nothing to import.");
  process.exit(0);
}

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Set VITE_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to import feedback.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});
const pageRecords = new Map((await loadGoldenPageRecords()).map((page) => [page.pageId, page]));
const conflicts = [];
const importedIds = [];
let plannedCount = 0;

const { data, error } = await supabase
  .from("finding_verdicts")
  .select(`
    id,
    verdict,
    note,
    canonical_kind,
    canonical_payload_json,
    canonical_status,
    engraving_findings:engraving_finding_id (
      id,
      page_number,
      asset_filename,
      severity,
      evidence,
      recommendation,
      metadata_json
    )
  `)
  .eq("canonical_status", "canonicalized")
  .order("canonicalized_at", { ascending: true });

if (error) {
  throw new Error(`Unable to load canonicalized feedback: ${error.message}`);
}

for (const row of data ?? []) {
  const entry = buildTruthEntry(row);
  if (!entry.pageId) {
    conflicts.push(`feedback ${row.id}: missing canonical_payload_json.page.`);
    continue;
  }
  const page = pageRecords.get(entry.pageId);
  if (!page) {
    conflicts.push(`feedback ${row.id}: page ${entry.pageId} is not in eval/golden/manifest.json.`);
    continue;
  }

  const truthFile = path.join(paths.goldenTruth, `${entry.pageId}.json`);
  const truth = normalizeTruth(
    (await pathExists(truthFile))
      ? await readJson(truthFile)
      : {
          exhaustive: false,
          findings: [],
          known_false_positives: [],
          labeled_at: new Date().toISOString().slice(0, 10),
          labeler: "feedback-import",
          page: entry.pageId,
        },
    { page, source: "verdict" },
  );

  const conflict = mergeEntry({ entry, row, truth });
  if (conflict) {
    conflicts.push(conflict);
    continue;
  }

  plannedCount += 1;
  if (!dryRun) {
    await writeJson(truthFile, truth);
    importedIds.push(row.id);
  }
}

if (!dryRun && importedIds.length) {
  const { error: updateError } = await supabase
    .from("finding_verdicts")
    .update({ canonical_status: "imported", updated_at: new Date().toISOString() })
    .in("id", importedIds);
  if (updateError) {
    conflicts.push(`Unable to mark imported feedback rows: ${updateError.message}`);
  }
}

await ensureDir(paths.report);
await writeFile(
  path.join(paths.report, "feedback_import_review.md"),
  [
    "# Feedback Import Review",
    "",
    `Dry run: ${dryRun ? "yes" : "no"}`,
    `${dryRun ? "Would import" : "Imported"}: ${dryRun ? plannedCount : importedIds.length}`,
    `Conflicts: ${conflicts.length}`,
    "",
    ...conflicts.map((item) => `- ${item}`),
    "",
  ].join("\n"),
);

console.log(
  `[eval:import-feedback] ${dryRun ? "Would import" : "Imported"} ${dryRun ? plannedCount : importedIds.length} feedback item${(dryRun ? plannedCount : importedIds.length) === 1 ? "" : "s"}.`,
);
if (conflicts.length) {
  console.warn(`[eval:import-feedback] ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"} written to eval/report/feedback_import_review.md.`);
}

function mergeEntry({ entry, row, truth }) {
  if (entry.kind === "discard") return null;

  if (entry.kind === "known_false_positive") {
    const fpId = entry.payload.fp_id ?? `verdict-${row.id.slice(0, 8)}`;
    if ((truth.known_false_positives ?? []).some((item) => item.fp_id === fpId)) {
      return `feedback ${row.id}: known_false_positive ${fpId} already exists.`;
    }
    truth.known_false_positives.push({
      ...entry.payload,
      fp_id: fpId,
      source: "verdict",
    });
    return null;
  }

  const gtId = entry.payload.gt_id ?? `verdict-${row.id.slice(0, 8)}`;
  if (truth.findings.some((finding) => finding.gt_id === gtId)) {
    return `feedback ${row.id}: finding ${gtId} already exists.`;
  }
  truth.findings.push({
    ...entry.payload,
    gt_id: gtId,
    rule_id: entry.kind === "ignore" ? "IGNORE" : entry.payload.rule_id,
    source: entry.kind === "user_miss" ? "user_miss" : "verdict",
    suppressed: entry.kind === "suppressed",
  });
  return null;
}

function buildTruthEntry(row) {
  const payload = row.canonical_payload_json ?? {};
  const finding = row.engraving_findings ?? {};
  const metadata = finding.metadata_json ?? {};
  const pageId = text(payload.page ?? metadata.source_page_id);
  const kind = text(row.canonical_kind);
  return {
    kind,
    pageId,
    payload: {
      ...payload,
      measure_number: nullableNumber(payload.measure_number ?? payload.measure ?? metadata.measure_number),
      note: text(payload.note ?? row.note ?? finding.evidence),
      rule_id: text(payload.rule_id ?? payload.rule ?? metadata.rule_id),
      severity: text(payload.severity ?? finding.severity) || "medium",
      staff_label: nullableText(payload.staff_label ?? payload.staff ?? metadata.staff_label),
      system_number: nullableNumber(payload.system_number ?? payload.system ?? metadata.system_number),
    },
  };
}

function nullableNumber(value) {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function nullableText(value) {
  const valueText = text(value);
  return valueText || null;
}

function text(value) {
  return String(value ?? "").trim();
}
