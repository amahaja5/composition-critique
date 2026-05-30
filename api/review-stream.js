import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const MAX_XML_CHARS = 120_000;
const MAX_PDF_BYTES = 30 * 1024 * 1024;
const COMPRESSED_MUSICXML_MIME_TYPE =
  "application/vnd.recordare.musicxml-compressed";
const REVIEW_PROMPT_VERSION = "2026-05-30";

const technicalPromptUrl = new URL(
  "../system_prompts/technical_review_system_prompt.md",
  import.meta.url,
);
const actionablePromptUrl = new URL(
  "../system_prompts/actionable_review_system_prompt.md",
  import.meta.url,
);

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization, content-type",
    );
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  res.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let captureSupabase = null;
  let reviewRunId = null;

  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      sendSse(res, "error", {
        message: "ANTHROPIC_API_KEY is not configured.",
      });
      return;
    }

    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey =
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) {
      sendSse(res, "error", {
        message: "Supabase environment is not configured.",
      });
      return;
    }

    const token = getBearerToken(req);
    if (!token) {
      sendSse(res, "error", { message: "Missing authorization token." });
      return;
    }

    const body = await readJsonBody(req);
    const compositionId = body?.composition_id;
    if (!compositionId) {
      sendSse(res, "error", { message: "Missing composition_id." });
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    });
    captureSupabase = createReviewCaptureClient(supabaseUrl);

    const { data: userData, error: userError } =
      await supabase.auth.getUser(token);
    if (userError || !userData.user) {
      sendSse(res, "error", { message: "Unable to validate signed-in user." });
      return;
    }

    sendSse(res, "status", { message: "Loading submitted files." });
    const { composition, assets } = await loadSubmission(
      supabase,
      compositionId,
    );
    const sourceContent = await buildSourceContent(
      supabase,
      composition,
      assets,
    );
    const [technicalPrompt, actionablePrompt] = await Promise.all([
      readFile(technicalPromptUrl, "utf8"),
      readFile(actionablePromptUrl, "utf8"),
    ]);

    const anthropic = new Anthropic({ apiKey });
    const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-4-8";
    reviewRunId = randomUUID();
    await createReviewRun(captureSupabase, {
      assets,
      compositionId,
      model,
      ownerId: userData.user.id,
      reviewRunId,
    });

    sendSse(res, "status", { message: "Analyzing submitted score." });
    const technicalReview = await streamAnthropicReview({
      anthropic,
      captureSupabase,
      compositionId,
      content: sourceContent,
      emitDeltas: false,
      inputSummary: summarizeAnthropicContent(sourceContent),
      model,
      ownerId: userData.user.id,
      promptName: "technical_review_system_prompt",
      responseKind: "technical_analysis",
      res,
      reviewRunId,
      status: "Running technical review.",
      system: technicalPrompt,
    });

    sendSse(res, "status", { message: "Writing composer-facing review." });
    await streamAnthropicReview({
      anthropic,
      captureSupabase,
      compositionId,
      content: [
        {
          type: "text",
          text: [
            `Composition: ${composition.title}`,
            "",
            "Technical analysis from the first review pass:",
            technicalReview,
          ].join("\n"),
        },
      ],
      emitDeltas: true,
      inputSummary: {
        source: "technical_analysis_response",
        technical_analysis_sha256: hashText(technicalReview),
        technical_analysis_chars: technicalReview.length,
      },
      model,
      ownerId: userData.user.id,
      promptName: "actionable_review_system_prompt",
      responseKind: "composer_review",
      res,
      reviewRunId,
      status: "Preparing actionable feedback.",
      system: actionablePrompt,
    });

    await completeReviewRun(captureSupabase, reviewRunId);
    sendSse(res, "done", { review_id: reviewRunId });
  } catch (error) {
    await failReviewRun(captureSupabase, reviewRunId, error);
    sendSse(res, "error", {
      message:
        error instanceof Error ? error.message : "Unable to create review.",
    });
  } finally {
    res.end();
  }
}

function createReviewCaptureClient(supabaseUrl) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    console.warn("[review] SUPABASE_SERVICE_ROLE_KEY is missing; review capture is disabled.");
    return null;
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getBearerToken(req) {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" ? token : "";
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    return req.body ? JSON.parse(req.body) : {};
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body.length ? JSON.parse(req.body.toString("utf8")) : {};
  }

  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
  }

  return raw ? JSON.parse(raw) : {};
}

async function loadSubmission(supabase, compositionId) {
  const { data: composition, error: compositionError } = await supabase
    .from("compositions")
    .select("id,title")
    .eq("id", compositionId)
    .single();

  if (compositionError || !composition) {
    throw new Error("Submitted composition was not found for this user.");
  }

  const { data: assets, error: assetsError } = await supabase
    .from("composition_assets")
    .select(
      "asset_type,byte_size,mime_type,original_filename,storage_bucket,storage_path",
    )
    .eq("composition_id", compositionId)
    .order("created_at", { ascending: true });

  if (assetsError) {
    throw new Error("Unable to load submitted assets.");
  }

  if (!assets?.length) {
    throw new Error("No submitted assets were found for this composition.");
  }

  return { assets, composition };
}

async function buildSourceContent(supabase, composition, assets) {
  const content = [
    {
      type: "text",
      text: `Review the submitted composition titled "${composition.title}".`,
    },
  ];

  for (const asset of assets) {
    const { data: blob, error } = await supabase.storage
      .from(asset.storage_bucket)
      .download(asset.storage_path);

    if (error || !blob) {
      throw new Error(`Unable to load ${asset.original_filename}.`);
    }

    if (asset.asset_type === "pdf") {
      if (asset.byte_size > MAX_PDF_BYTES) {
        throw new Error(
          `${asset.original_filename} is too large for direct PDF review.`,
        );
      }

      content.push({
        type: "document",
        source: {
          type: "base64",
          media_type: getReviewMediaType(asset),
          data: Buffer.from(await blob.arrayBuffer()).toString("base64"),
        },
      });
      continue;
    }

    if (isCompressedMusicXml(asset)) {
      content.push({
        type: "text",
        text: `${asset.original_filename} is a compressed MusicXML file and could not be expanded by this endpoint.`,
      });
      continue;
    }

    const sourceText = await blob.text();
    content.push({
      type: "text",
      text: [
        `Source file: ${asset.original_filename}`,
        "",
        sourceText.slice(0, MAX_XML_CHARS),
      ].join("\n"),
    });
  }

  return content;
}

function getReviewMediaType(asset) {
  if (
    asset.asset_type === "pdf" ||
    hasExtension(asset.original_filename, ".pdf")
  ) {
    return "application/pdf";
  }

  if (isCompressedMusicXml(asset)) {
    return COMPRESSED_MUSICXML_MIME_TYPE;
  }

  if (
    hasExtension(asset.original_filename, ".musicxml") ||
    hasExtension(asset.original_filename, ".xml")
  ) {
    return "application/xml";
  }

  return asset.mime_type || "application/octet-stream";
}

function isCompressedMusicXml(asset) {
  return (
    asset.mime_type === COMPRESSED_MUSICXML_MIME_TYPE ||
    hasExtension(asset.original_filename, ".mxl")
  );
}

function hasExtension(filename, extension) {
  return filename?.toLowerCase().endsWith(extension) ?? false;
}

async function streamAnthropicReview({
  anthropic,
  captureSupabase,
  compositionId,
  content,
  emitDeltas = true,
  inputSummary = {},
  model,
  ownerId,
  promptName,
  responseKind,
  res,
  reviewRunId,
  status,
  system,
}) {
  let output = "";
  let errorMessage = null;
  let messageJson = {};
  let usageJson = {};
  const responseId = randomUUID();
  const streamEvents = [];
  sendSse(res, "status", { message: status });

  try {
    const stream = await anthropic.messages.create({
      max_tokens: 1600,
      cache_control: { type: "ephemeral" },
      messages: [{ role: "user", content }],
      model,
      stream: true,
      system,
    });

    for await (const event of stream) {
      streamEvents.push(toJson(event));
      if (event.type === "message_start") {
        messageJson = toJson(event.message);
        usageJson = mergeUsage(usageJson, event.message?.usage);
      }
      if (event.type === "message_delta") {
        messageJson = { ...messageJson, delta: toJson(event.delta) };
        usageJson = mergeUsage(usageJson, event.usage);
      }
      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "text_delta"
      ) {
        output += event.delta.text;
        if (emitDeltas) {
          sendSse(res, "delta", { text: event.delta.text });
        }
      }
    }
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : "Anthropic response failed.";
    throw error;
  } finally {
    await recordReviewResponse(captureSupabase, {
      compositionId,
      errorMessage,
      inputSummary,
      messageJson,
      model,
      output,
      ownerId,
      promptName,
      responseId,
      responseKind,
      reviewRunId,
      status: errorMessage ? "failed" : "completed",
      streamEvents,
      system,
      usageJson,
    });
  }

  return output;
}

async function createReviewRun(
  supabase,
  { assets, compositionId, model, ownerId, reviewRunId },
) {
  if (!supabase) return;

  const { error } = await supabase.from("review_runs").insert({
    id: reviewRunId,
    composition_id: compositionId,
    owner_id: ownerId,
    provider: "anthropic",
    model,
    status: "running",
    metadata_json: {
      asset_count: assets.length,
      asset_types: assets.map((asset) => asset.asset_type),
    },
  });

  if (error) {
    console.warn("[review] Unable to create review run.", error);
  }
}

async function completeReviewRun(supabase, reviewRunId) {
  if (!supabase || !reviewRunId) return;

  const { error } = await supabase
    .from("review_runs")
    .update({
      completed_at: new Date().toISOString(),
      status: "completed",
    })
    .eq("id", reviewRunId);

  if (error) {
    console.warn("[review] Unable to complete review run.", error);
  }
}

async function failReviewRun(supabase, reviewRunId, error) {
  if (!supabase || !reviewRunId) return;

  const { error: updateError } = await supabase
    .from("review_runs")
    .update({
      completed_at: new Date().toISOString(),
      error_message:
        error instanceof Error ? error.message : "Review stream failed.",
      status: "failed",
    })
    .eq("id", reviewRunId);

  if (updateError) {
    console.warn("[review] Unable to mark review run failed.", updateError);
  }
}

async function recordReviewResponse(
  supabase,
  {
    compositionId,
    errorMessage,
    inputSummary,
    messageJson,
    model,
    output,
    ownerId,
    promptName,
    responseId,
    responseKind,
    reviewRunId,
    status,
    streamEvents,
    system,
    usageJson,
  },
) {
  if (!supabase || !reviewRunId) return;

  const { error } = await supabase.from("review_responses").insert({
    id: responseId,
    review_run_id: reviewRunId,
    composition_id: compositionId,
    owner_id: ownerId,
    response_kind: responseKind,
    provider: "anthropic",
    model,
    prompt_name: promptName,
    prompt_version: REVIEW_PROMPT_VERSION,
    system_prompt: system,
    input_summary_json: inputSummary,
    response_text: output,
    response_json: {
      message: messageJson,
      output_text: output,
    },
    stream_events_json: streamEvents,
    usage_json: usageJson,
    status,
    error_message: errorMessage,
    completed_at: new Date().toISOString(),
  });

  if (error) {
    console.warn("[review] Unable to store review response.", error);
  }
}

function summarizeAnthropicContent(content) {
  return {
    blocks: content.map((block) => {
      if (block.type === "text") {
        return {
          type: "text",
          char_count: block.text.length,
          sha256: hashText(block.text),
          preview: block.text.slice(0, 500),
        };
      }

      if (block.type === "document") {
        return {
          type: "document",
          media_type: block.source?.media_type ?? null,
          source_type: block.source?.type ?? null,
          data_sha256: hashText(block.source?.data ?? ""),
          encoded_byte_count: block.source?.data?.length ?? 0,
        };
      }

      return { type: block.type ?? "unknown" };
    }),
  };
}

function mergeUsage(current, next) {
  return next ? { ...current, ...toJson(next) } : current;
}

function toJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : {};
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}
