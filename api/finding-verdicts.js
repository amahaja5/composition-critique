import {
  authenticateRequest,
  createServiceClient,
  handleOptions,
  readJsonBody,
  sendJson,
} from "./lib/supabaseServer.js";

const VERDICTS = new Set(["useful", "irrelevant", "not_true"]);

export default async function handler(req, res) {
  if (handleOptions(req, res, "POST, OPTIONS")) return;
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const auth = await authenticateRequest(req);
    if (auth.error) {
      sendJson(res, auth.status, { error: auth.error });
      return;
    }

    const body = await readJsonBody(req);
    const findingId = text(body.finding_db_id ?? body.engraving_finding_id);
    const verdict = text(body.verdict);
    if (!findingId) {
      sendJson(res, 400, { error: "Missing finding_db_id." });
      return;
    }
    if (!VERDICTS.has(verdict)) {
      sendJson(res, 400, { error: "Unsupported verdict." });
      return;
    }

    const service = createServiceClient();
    const { data: finding, error: findingError } = await service
      .from("engraving_findings")
      .select("id,review_run_id,composition_id,owner_id,page_number,asset_filename,metadata_json,category,severity,evidence,recommendation")
      .eq("id", findingId)
      .single();

    if (findingError || !finding) {
      sendJson(res, 404, { error: "Finding not found." });
      return;
    }
    if (finding.owner_id !== auth.user.id) {
      sendJson(res, 403, { error: "You cannot submit feedback for this finding." });
      return;
    }

    const row = {
      canonical_kind: null,
      canonical_payload_json: {},
      canonical_status: "pending",
      canonicalized_at: null,
      canonicalized_by: null,
      composition_id: finding.composition_id,
      engraving_finding_id: finding.id,
      metadata_json: {
        asset_filename: finding.asset_filename,
        category: finding.category,
        finding_metadata: finding.metadata_json ?? {},
        page_number: finding.page_number,
        rule_id: finding.metadata_json?.rule_id ?? null,
        severity: finding.severity,
      },
      note: text(body.note),
      owner_id: auth.user.id,
      review_run_id: finding.review_run_id,
      updated_at: new Date().toISOString(),
      verdict,
    };

    const { data: verdictRow, error: upsertError } = await service
      .from("finding_verdicts")
      .upsert(row, { onConflict: "engraving_finding_id,owner_id" })
      .select("*")
      .single();

    if (upsertError) {
      sendJson(res, 500, { error: "Unable to store finding feedback." });
      return;
    }

    sendJson(res, 200, { verdict: verdictRow });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Finding feedback failed.",
    });
  }
}

function text(value) {
  return String(value ?? "").trim();
}
