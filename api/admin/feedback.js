import {
  authenticateRequest,
  createServiceClient,
  handleOptions,
  readJsonBody,
  sendJson,
} from "../lib/supabaseServer.js";

const CANONICAL_KINDS = new Set([
  "accepted",
  "suppressed",
  "known_false_positive",
  "user_miss",
  "ignore",
  "discard",
]);

export default async function handler(req, res) {
  if (handleOptions(req, res, "GET, PATCH, OPTIONS")) return;
  if (!["GET", "PATCH"].includes(req.method)) {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const auth = await authenticateRequest(req);
    if (auth.error) {
      sendJson(res, auth.status, { error: auth.error });
      return;
    }
    if (!isFeedbackAdmin(auth.user.email)) {
      sendJson(res, 403, { error: "Feedback admin access is not enabled for this user." });
      return;
    }

    if (req.method === "GET") {
      await listFeedback(req, res);
      return;
    }

    await canonicalizeFeedback(req, res, auth.user);
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : "Feedback admin request failed.",
    });
  }
}

async function listFeedback(req, res) {
  const service = createServiceClient();
  const status = new URL(req.url, "http://localhost").searchParams.get("status") || "pending";
  const { data, error } = await service
    .from("finding_verdicts")
    .select(`
      *,
      engraving_findings:engraving_finding_id (
        id,
        page_number,
        asset_filename,
        location_label,
        category,
        severity,
        evidence,
        recommendation,
        metadata_json
      ),
      review_runs:review_run_id (
        id,
        model,
        metadata_json,
        started_at
      ),
      compositions:composition_id (
        id,
        title
      )
    `)
    .eq("canonical_status", status)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) {
    sendJson(res, 500, { error: "Unable to load feedback queue." });
    return;
  }
  sendJson(res, 200, { feedback: data ?? [] });
}

async function canonicalizeFeedback(req, res, user) {
  const body = await readJsonBody(req);
  const verdictId = text(body.verdict_id ?? body.id);
  const canonicalKind = text(body.canonical_kind);
  if (!verdictId) {
    sendJson(res, 400, { error: "Missing verdict_id." });
    return;
  }
  if (!CANONICAL_KINDS.has(canonicalKind)) {
    sendJson(res, 400, { error: "Unsupported canonical_kind." });
    return;
  }

  const canonicalStatus = canonicalKind === "discard" ? "discarded" : "canonicalized";
  const service = createServiceClient();
  const { data, error } = await service
    .from("finding_verdicts")
    .update({
      canonical_kind: canonicalKind,
      canonical_payload_json: body.canonical_payload_json ?? {},
      canonical_status: canonicalStatus,
      canonicalized_at: new Date().toISOString(),
      canonicalized_by: user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", verdictId)
    .select("*")
    .single();

  if (error) {
    sendJson(res, 500, { error: "Unable to canonicalize feedback." });
    return;
  }
  sendJson(res, 200, { feedback: data });
}

function isFeedbackAdmin(email) {
  const admins = String(process.env.FEEDBACK_ADMIN_EMAILS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  return admins.includes(String(email ?? "").trim().toLowerCase());
}

function text(value) {
  return String(value ?? "").trim();
}
