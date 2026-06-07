import Anthropic from "@anthropic-ai/sdk";
import { createCanvas } from "@napi-rs/canvas";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { WorkerMessageHandler } from "pdfjs-dist/legacy/build/pdf.worker.mjs";

const REVIEW_PROMPT_VERSION = "2026-05-30";
const DEFAULT_QWEN_BASE_URL = "https://router.huggingface.co/v1";
const DEFAULT_QWEN_MODEL = "Qwen/Qwen3-VL-8B-Instruct:novita";
const DEFAULT_HAIKU_MODEL = "claude-haiku-4-5";
const DEFAULT_MAX_PAGES = 12;
const DEFAULT_PAGES_PER_CALL = 3;
const DEFAULT_RENDER_SCALE = 2;
const MAX_PDF_BYTES = 30 * 1024 * 1024;

globalThis.pdfjsWorker ??= { WorkerMessageHandler };

const pagePromptUrl = new URL(
  "../system_prompts/engraving_page_analysis_system_prompt.md",
  import.meta.url,
);
const polishPromptUrl = new URL(
  "../system_prompts/engraving_polish_system_prompt.md",
  import.meta.url,
);

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type");
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
    const supabaseUrl = process.env.VITE_SUPABASE_URL;
    const supabaseKey =
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      process.env.VITE_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseKey) {
      sendSse(res, "error", { message: "Supabase environment is not configured." });
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
    const action = body?.action ?? "analyze";

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    captureSupabase = createReviewCaptureClient(supabaseUrl);

    const { data: userData, error: userError } =
      await supabase.auth.getUser(token);
    if (userError || !userData.user) {
      sendSse(res, "error", { message: "Unable to validate signed-in user." });
      return;
    }

    if (action === "polish") {
      await handlePolishRequest({
        body,
        captureSupabase,
        compositionId,
        ownerId: userData.user.id,
        res,
        supabase,
      });
      return;
    }

    if (action !== "analyze") {
      sendSse(res, "error", { message: "Unsupported engraving review action." });
      return;
    }

    const qwenConfig = getQwenConfig();
    const qwen = new OpenAI({
      apiKey: qwenConfig.apiKey,
      baseURL: qwenConfig.baseURL,
    });

    sendSse(res, "status", { message: "Loading submitted PDF." });
    const { composition, assets } = await loadSubmission(supabase, compositionId);
    const pdfAssets = assets.filter(isPdfAsset);
    if (!pdfAssets.length) {
      throw new Error("Engraving review requires a submitted PDF.");
    }

    reviewRunId = randomUUID();
    await createReviewRun(captureSupabase, {
      assets: pdfAssets,
      compositionId,
      model: qwenConfig.model,
      ownerId: userData.user.id,
      provider: "qwen_openai",
      reviewRunId,
    });

    const renderOptions = getRenderOptions();
    sendSse(res, "status", { message: "Rendering score pages for engraving review." });
    const pages = await renderSubmittedPdfPages(supabase, pdfAssets, renderOptions);
    if (!pages.length) {
      throw new Error("No PDF pages could be rendered for engraving review.");
    }

    const pagePrompt = await readFile(pagePromptUrl, "utf8");

    sendSse(res, "status", { message: "Inspecting engraving details with Qwen." });
    const findings = [];
    for (const pageBatch of chunkItems(pages, renderOptions.pagesPerCall)) {
      const response = await streamQwenChat({
        captureSupabase,
        composition,
        inputSummary: summarizePageBatch(pageBatch),
        messages: buildPageAnalysisMessages({
          composition,
          pageBatch,
          systemPrompt: pagePrompt,
        }),
        model: qwenConfig.model,
        ownerId: userData.user.id,
        promptName: "engraving_page_analysis_system_prompt",
        provider: "qwen_openai",
        qwen,
        responseKind: "engraving_page_analysis",
        reviewRunId,
        system: pagePrompt,
      });

      const parsed = parseJsonObject(response.output);
      const batchFindings = normalizeFindings(parsed, pageBatch);
      findings.push(...batchFindings);
      await recordEngravingFindings(captureSupabase, {
        compositionId,
        findings: batchFindings,
        ownerId: userData.user.id,
        reviewResponseId: response.responseId,
        reviewRunId,
      });
    }

    sendSse(res, "status", {
      message: "Engraving findings ready. Use Polish output for a cleaner report.",
    });
    sendSse(res, "delta", {
      text: buildFindingsMarkdown({
        composition,
        findings,
        pages,
      }),
    });

    await completeReviewRun(captureSupabase, reviewRunId);
    sendSse(res, "done", {
      can_polish: true,
      finding_count: findings.length,
      review_id: reviewRunId,
    });
  } catch (error) {
    await failReviewRun(captureSupabase, reviewRunId, error);
    sendSse(res, "error", {
      message:
        error instanceof Error
          ? error.message
          : "Unable to create engraving review.",
    });
  } finally {
    res.end();
  }
}

async function handlePolishRequest({
  body,
  captureSupabase,
  compositionId,
  ownerId,
  res,
  supabase,
}) {
  const sourceText = String(body?.source_text ?? "").trim();
  if (!sourceText) {
    sendSse(res, "error", { message: "No engraving findings were provided to polish." });
    return;
  }

  const composition = await loadComposition(supabase, compositionId);
  const polishPrompt = await readFile(polishPromptUrl, "utf8");
  const reviewRunId =
    typeof body?.review_run_id === "string" && body.review_run_id
      ? body.review_run_id
      : randomUUID();
  const shouldCreateRun = reviewRunId !== body?.review_run_id;

  if (shouldCreateRun) {
    await createReviewRun(captureSupabase, {
      assets: [],
      compositionId,
      model:
        process.env.ANTHROPIC_POLISH_MODEL ??
        process.env.ANTHROPIC_MODEL ??
        DEFAULT_HAIKU_MODEL,
      ownerId,
      provider: "anthropic",
      reviewRunId,
    });
  }

  sendSse(res, "status", { message: "Polishing engraving report with Haiku." });
  const reportInput = buildPolishInput({
    composition,
    sourceText,
  });

  await streamHaikuPolish({
    captureSupabase,
    compositionId,
    inputSummary: {
      source: "visible_qwen_engraving_findings",
      source_text_chars: sourceText.length,
      source_text_sha256: hashText(sourceText),
    },
    model:
      process.env.ANTHROPIC_POLISH_MODEL ??
      process.env.ANTHROPIC_MODEL ??
      DEFAULT_HAIKU_MODEL,
    ownerId,
    promptName: "engraving_polish_system_prompt",
    provider: "anthropic",
    res,
    responseKind: "engraving_summary",
    reviewRunId,
    system: polishPrompt,
    userText: reportInput,
  });

  await completeReviewRun(captureSupabase, reviewRunId);
  sendSse(res, "done", { polished: true, review_id: reviewRunId });
}

async function loadComposition(supabase, compositionId) {
  const { data: composition, error } = await supabase
    .from("compositions")
    .select("id,title")
    .eq("id", compositionId)
    .single();

  if (error || !composition) {
    throw new Error("Submitted composition was not found for this user.");
  }

  return composition;
}

function getQwenConfig() {
  const baseURL =
    process.env.QWEN_OPENAI_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    DEFAULT_QWEN_BASE_URL;
  const isHuggingFaceRouter = baseURL.includes("router.huggingface.co");
  const apiKey = isHuggingFaceRouter
    ? process.env.QWEN_OPENAI_API_KEY ?? process.env.HF_TOKEN
    : process.env.QWEN_OPENAI_API_KEY ??
      process.env.OPENAI_API_KEY ??
      process.env.HF_TOKEN;
  const model =
    process.env.QWEN_OPENAI_MODEL ??
    process.env.QWEN_ENGRAVING_MODEL ??
    DEFAULT_QWEN_MODEL;

  if (!apiKey) {
    throw new Error(
      isHuggingFaceRouter
        ? "Set HF_TOKEN or QWEN_OPENAI_API_KEY for Hugging Face Router."
        : "Set QWEN_OPENAI_API_KEY for Qwen engraving review.",
    );
  }

  return { apiKey, baseURL, model };
}

function getRenderOptions() {
  return {
    maxPages: toPositiveInt(process.env.QWEN_MAX_PAGES, DEFAULT_MAX_PAGES),
    pagesPerCall: toPositiveInt(
      process.env.QWEN_PAGES_PER_CALL,
      DEFAULT_PAGES_PER_CALL,
    ),
    renderScale: toPositiveNumber(
      process.env.QWEN_RENDER_SCALE,
      DEFAULT_RENDER_SCALE,
    ),
  };
}

function createReviewCaptureClient(supabaseUrl) {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    console.warn(
      "[engraving] SUPABASE_SERVICE_ROLE_KEY is missing; review capture is disabled.",
    );
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
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
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
      "id,asset_type,byte_size,mime_type,original_filename,storage_bucket,storage_path",
    )
    .eq("composition_id", compositionId)
    .order("created_at", { ascending: true });

  if (assetsError) throw new Error("Unable to load submitted assets.");
  if (!assets?.length) {
    throw new Error("No submitted assets were found for this composition.");
  }

  return { assets, composition };
}

function isPdfAsset(asset) {
  return (
    asset.asset_type === "pdf" ||
    asset.mime_type === "application/pdf" ||
    asset.original_filename?.toLowerCase().endsWith(".pdf")
  );
}

async function renderSubmittedPdfPages(supabase, pdfAssets, options) {
  const pages = [];

  for (const asset of pdfAssets) {
    if (pages.length >= options.maxPages) break;

    if (asset.byte_size > MAX_PDF_BYTES) {
      throw new Error(`${asset.original_filename} is too large for engraving review.`);
    }

    const { data: blob, error } = await supabase.storage
      .from(asset.storage_bucket)
      .download(asset.storage_path);

    if (error || !blob) {
      throw new Error(`Unable to load ${asset.original_filename}.`);
    }

    const pdfBytes = Buffer.from(await blob.arrayBuffer());
    const rendered = await renderPdfPages({
      asset,
      maxPages: options.maxPages - pages.length,
      pdfBytes,
      renderScale: options.renderScale,
    });
    pages.push(...rendered);
  }

  return pages;
}

async function renderPdfPages({ asset, maxPages, pdfBytes, renderScale }) {
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(pdfBytes),
    disableFontFace: true,
    useSystemFonts: true,
  });
  const pdf = await loadingTask.promise;
  const pageCount = Math.min(pdf.numPages, maxPages);
  const pages = [];

  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: renderScale });
      const canvasFactory = new NodeCanvasFactory();
      const canvasAndContext = canvasFactory.create(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );

      try {
        await page.render({
          canvasContext: canvasAndContext.context,
          canvasFactory,
          viewport,
        }).promise;

        const imageBuffer = canvasAndContext.canvas.toBuffer("image/png");
        const sourcePageId = `${asset.id}:${pageNumber}`;
        pages.push({
          assetFilename: asset.original_filename,
          assetId: asset.id,
          dataUrl: `data:image/png;base64,${imageBuffer.toString("base64")}`,
          height: canvasAndContext.canvas.height,
          imageSha256: hashBytes(imageBuffer),
          pageNumber,
          sourcePageId,
          storagePath: asset.storage_path,
          width: canvasAndContext.canvas.width,
        });
      } finally {
        canvasFactory.destroy(canvasAndContext);
        page.cleanup();
      }
    }
  } finally {
    await loadingTask.destroy();
  }

  return pages;
}

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
    canvasAndContext.canvas = null;
    canvasAndContext.context = null;
  }
}

function buildPageAnalysisMessages({ composition, pageBatch, systemPrompt }) {
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: [
            `Composition: ${composition.title}`,
            "",
            "Inspect these score pages for engraving issues only.",
            "Return JSON only using the requested schema.",
            "",
            "Pages:",
            ...pageBatch.map(
              (page) =>
                `- source_page_id=${page.sourcePageId}; file=${page.assetFilename}; page=${page.pageNumber}; size=${page.width}x${page.height}`,
            ),
          ].join("\n"),
        },
        ...pageBatch.map((page) => ({
          type: "image_url",
          image_url: {
            url: page.dataUrl,
          },
        })),
      ],
    },
  ];
}

async function streamQwenChat({
  captureSupabase,
  composition,
  inputSummary,
  messages,
  model,
  ownerId,
  promptName,
  provider,
  qwen,
  responseKind,
  reviewRunId,
  system,
}) {
  let output = "";
  let errorMessage = null;
  let messageJson = {};
  let usageJson = {};
  const responseId = randomUUID();
  const streamEvents = [];

  try {
    const stream = await qwen.chat.completions.create({
      max_tokens: 1800,
      messages,
      model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.1,
    });

    for await (const chunk of stream) {
      const chunkJson = toJson(chunk);
      streamEvents.push(chunkJson);
      usageJson = mergeUsage(usageJson, chunk.usage);
      const choice = chunk.choices?.[0];
      if (choice?.delta) {
        messageJson = {
          ...messageJson,
          role: choice.delta.role ?? messageJson.role ?? "assistant",
        };
      }
      const text = extractChatDeltaText(choice?.delta?.content);
      if (text) output += text;
      if (choice?.finish_reason) {
        messageJson.finish_reason = choice.finish_reason;
      }
    }

    messageJson.content = output;
  } catch (error) {
    errorMessage = formatProviderError("Qwen engraving analysis", error);
    throw new Error(errorMessage, { cause: error });
  } finally {
    await recordReviewResponse(captureSupabase, {
      compositionId: composition.id,
      errorMessage,
      inputSummary,
      messageJson,
      model,
      output,
      ownerId,
      promptName,
      provider,
      responseId,
      responseKind,
      reviewRunId,
      status: errorMessage ? "failed" : "completed",
      streamEvents,
      system,
      usageJson,
    });
  }

  return { output, responseId };
}

async function streamHaikuPolish({
  captureSupabase,
  compositionId,
  inputSummary,
  model,
  ownerId,
  promptName,
  provider,
  res,
  responseKind,
  reviewRunId,
  system,
  userText,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is required for Haiku engraving polish.");
  }

  const anthropic = new Anthropic({ apiKey });
  let output = "";
  let errorMessage = null;
  let messageJson = {};
  let usageJson = {};
  const responseId = randomUUID();
  const streamEvents = [];

  try {
    const stream = await anthropic.messages.create({
      max_tokens: 1400,
      messages: [{ role: "user", content: userText }],
      model,
      stream: true,
      system,
      temperature: 0.2,
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
        sendSse(res, "delta", { text: event.delta.text });
      }
    }
  } catch (error) {
    errorMessage = formatProviderError("Haiku engraving polish", error);
    throw new Error(errorMessage, { cause: error });
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
      provider,
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

function extractChatDeltaText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        return part?.text ?? "";
      })
      .join("");
  }
  return "";
}

function formatProviderError(source, error) {
  if (!(error instanceof Error)) {
    return `${source} failed.`;
  }

  const status = error.status ? ` ${error.status}` : "";
  return `${source} failed${status}: ${error.message}`;
}

function parseJsonObject(text) {
  const withoutFence = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};

  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch (error) {
    console.warn("[engraving] Unable to parse Qwen findings JSON.", error);
    return {};
  }
}

function normalizeFindings(parsed, pageBatch) {
  const rawFindings = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.findings)
      ? parsed.findings
      : [];
  const pagesById = new Map(pageBatch.map((page) => [page.sourcePageId, page]));

  return rawFindings
    .map((finding) => {
      const sourcePageId =
        typeof finding.source_page_id === "string"
          ? finding.source_page_id
          : "";
      const fallbackPage = pageBatch.find(
        (page) => page.pageNumber === Number(finding.page_number ?? finding.page),
      );
      const page = pagesById.get(sourcePageId) ?? fallbackPage ?? pageBatch[0];
      const severity = normalizeSeverity(finding.severity);

      return {
        asset_filename: page.assetFilename,
        category: cleanText(finding.category) || "engraving",
        confidence:
          typeof finding.confidence === "number" ? finding.confidence : null,
        evidence: cleanText(finding.evidence),
        location_label:
          cleanText(finding.location_label) ||
          cleanText(finding.location) ||
          `Page ${page.pageNumber}`,
        metadata_json: {
          source_page_id: page.sourcePageId,
        },
        page_number: page.pageNumber,
        recommendation: cleanText(finding.recommendation),
        severity,
      };
    })
    .filter((finding) => finding.evidence || finding.recommendation);
}

function normalizeSeverity(value) {
  const severity = String(value ?? "").toLowerCase();
  return ["low", "medium", "high"].includes(severity) ? severity : "medium";
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function buildPolishInput({ composition, sourceText }) {
  return [
    `Composition: ${composition.title}`,
    "",
    "Visible engraving findings to polish:",
    sourceText,
  ].join("\n");
}

function buildFindingsMarkdown({ composition, findings, pages }) {
  const lines = [
    "## Engraving Findings",
    "",
    `Composition: ${composition.title}`,
    `Rendered pages inspected: ${pages.length}`,
    "",
  ];

  if (!findings.length) {
    lines.push(
      "No clear engraving issues were detected in the rendered pages.",
      "",
      "A manual print-readability pass is still recommended for page turns, part extraction, and final layout.",
    );
    return `${lines.join("\n")}\n`;
  }

  const sortedFindings = [...findings].sort((a, b) => {
    const pageDelta = (a.page_number ?? 0) - (b.page_number ?? 0);
    if (pageDelta) return pageDelta;
    return severityRank(b.severity) - severityRank(a.severity);
  });

  for (const finding of sortedFindings) {
    const heading = [
      `Page ${finding.page_number ?? "unknown"}`,
      finding.location_label,
      finding.category,
      finding.severity,
    ]
      .filter(Boolean)
      .join(" - ");
    lines.push(`### ${heading}`, "");
    if (finding.evidence) {
      lines.push(`- Observation: ${finding.evidence}`);
    }
    if (finding.recommendation) {
      lines.push(`- Recommendation: ${finding.recommendation}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}Use **Polish output** for a cleaner composer-facing version.\n`;
}

function severityRank(severity) {
  return { high: 3, medium: 2, low: 1 }[severity] ?? 0;
}

function summarizePageBatch(pageBatch) {
  return {
    pages: pageBatch.map((page) => ({
      asset_filename: page.assetFilename,
      height: page.height,
      image_sha256: page.imageSha256,
      page_number: page.pageNumber,
      source_page_id: page.sourcePageId,
      storage_path_sha256: hashText(page.storagePath),
      width: page.width,
    })),
  };
}

async function createReviewRun(
  supabase,
  { assets, compositionId, model, ownerId, provider, reviewRunId },
) {
  if (!supabase) return;

  const { error } = await supabase.from("review_runs").insert({
    id: reviewRunId,
    composition_id: compositionId,
    owner_id: ownerId,
    provider,
    model,
    status: "running",
    metadata_json: {
      asset_count: assets.length,
      asset_types: assets.map((asset) => asset.asset_type),
      review_type: "engraving",
    },
  });

  if (error) console.warn("[engraving] Unable to create review run.", error);
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

  if (error) console.warn("[engraving] Unable to complete review run.", error);
}

async function failReviewRun(supabase, reviewRunId, error) {
  if (!supabase || !reviewRunId) return;

  const { error: updateError } = await supabase
    .from("review_runs")
    .update({
      completed_at: new Date().toISOString(),
      error_message:
        error instanceof Error ? error.message : "Engraving review failed.",
      status: "failed",
    })
    .eq("id", reviewRunId);

  if (updateError) {
    console.warn("[engraving] Unable to mark review run failed.", updateError);
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
    provider,
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
    provider,
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

  if (error) console.warn("[engraving] Unable to store review response.", error);
}

async function recordEngravingFindings(
  supabase,
  { compositionId, findings, ownerId, reviewResponseId, reviewRunId },
) {
  if (!supabase || !findings.length) return;

  const { error } = await supabase.from("engraving_findings").insert(
    findings.map((finding) => ({
      ...finding,
      composition_id: compositionId,
      owner_id: ownerId,
      review_response_id: reviewResponseId,
      review_run_id: reviewRunId,
    })),
  );

  if (error) console.warn("[engraving] Unable to store findings.", error);
}

function chunkItems(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toPositiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}
