import { deriveCategoryFromRuleId } from "./engravingPromptAssembler.js";
import { buildAnthropicBase64ImageBlock } from "./engravingVisionFewShots.js";

export const DEFAULT_OPUS_MODEL = "claude-opus-4-8";
export const ADVISOR_BETA = "advisor-tool-2026-03-01";

export function getEngravingModelConfig(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  const model = env.ANTHROPIC_ENGRAVING_MODEL ?? DEFAULT_OPUS_MODEL;
  const advisorEnabled = toBoolean(env.ANTHROPIC_ENGRAVING_ADVISOR_ENABLED, false);
  const advisorModel = env.ANTHROPIC_ENGRAVING_ADVISOR_MODEL ?? DEFAULT_OPUS_MODEL;
  const advisorMaxUses = toPositiveInt(env.ANTHROPIC_ENGRAVING_ADVISOR_MAX_USES, 1);

  if (!apiKey) {
    throw new Error("Set ANTHROPIC_API_KEY for engraving review.");
  }

  return {
    advisor: {
      beta: ADVISOR_BETA,
      enabled: advisorEnabled,
      maxUses: advisorMaxUses,
      model: advisorModel,
    },
    apiKey,
    model,
  };
}

export function summarizeEngravingModelConfig(config) {
  return {
    advisor_enabled: Boolean(config?.advisor?.enabled),
    advisor_max_uses: config?.advisor?.enabled ? config.advisor.maxUses : 0,
    advisor_model: config?.advisor?.enabled ? config.advisor.model : null,
    beta: config?.advisor?.enabled ? config.advisor.beta : null,
    primary_model: config?.model ?? DEFAULT_OPUS_MODEL,
  };
}

export function buildPageAnalysisMessages({
  composition,
  pageBatch,
  routingMetadata,
}) {
  return [
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
            "Localize every finding with system_number and measure_number when visible. Use null only when the page cannot support that field.",
            "bbox_hint is optional normalized [x,y,w,h] guidance only; approximate is acceptable.",
            "",
            `Prompt routing: ${JSON.stringify({
              doc_type: routingMetadata.doc_type,
              features: routingMetadata.features,
              instrument_families: routingMetadata.instrument_families,
              instruments: routingMetadata.instruments,
              selected_chapters: routingMetadata.selected_chapters,
            })}`,
            "",
            "Pages:",
            ...pageBatch.map(
              (page) =>
                `- source_page_id=${page.sourcePageId}; file=${page.assetFilename}; page=${page.pageNumber}; size=${page.width}x${page.height}`,
            ),
          ].join("\n"),
        },
        ...pageBatch.map((page) => buildAnthropicImageBlock(page)),
      ],
    },
  ];
}

export function buildAnthropicImageBlock(page) {
  return buildAnthropicBase64ImageBlock({
    data: page.dataUrl.replace(/^data:image\/png;base64,/, ""),
    mediaType: "image/png",
  });
}

export function buildCachedSystem(system) {
  return [
    {
      cache_control: { type: "ephemeral" },
      text: system,
      type: "text",
    },
  ];
}

export async function createAnthropicMessage({
  advisor = null,
  anthropic,
  maxTokens = 1800,
  messages,
  model,
  system,
}) {
  const requestParams = {
    max_tokens: maxTokens,
    messages,
    model,
    system: buildCachedSystem(system),
  };

  return advisor?.enabled
    ? anthropic.beta.messages.create({
        ...requestParams,
        betas: [advisor.beta],
        tools: [
          {
            caching: { type: "ephemeral" },
            max_uses: advisor.maxUses,
            model: advisor.model,
            name: "advisor",
            type: "advisor_20260301",
          },
        ],
      })
    : anthropic.messages.create(requestParams);
}

export async function createValidatedPageAnalysis({
  advisor,
  anthropic,
  maxTokens = 1800,
  messages,
  model,
  system,
}) {
  const firstMessage = await createAnthropicMessage({
    advisor,
    anthropic,
    maxTokens,
    messages,
    model,
    system,
  });
  const firstOutput = extractAnthropicText(firstMessage.content);
  const firstParsed = parseJsonObject(firstOutput);
  const firstValidation = validatePageAnalysisOutput(firstParsed);

  if (firstValidation.valid) {
    return {
      output: firstOutput,
      parsed: firstParsed,
      rawMessage: firstMessage,
      retry: null,
    };
  }

  const retryMessages = [
    ...messages,
    {
      role: "assistant",
      content: firstOutput || "{}",
    },
    {
      role: "user",
      content: [
        "Your previous response did not match the required JSON contract.",
        `Validation error: ${firstValidation.message}`,
        "Return a corrected JSON object only. Do not add prose or markdown fences.",
      ].join("\n"),
    },
  ];
  const retryMessage = await createAnthropicMessage({
    advisor,
    anthropic,
    maxTokens,
    messages: retryMessages,
    model,
    system,
  });
  const retryOutput = extractAnthropicText(retryMessage.content);
  const retryParsed = parseJsonObject(retryOutput);
  const retryValidation = validatePageAnalysisOutput(retryParsed);

  if (!retryValidation.valid) {
    return {
      output: retryOutput,
      parsed: {
        findings: [],
        model_notes: [
          "Engraving analysis returned invalid structured JSON.",
          retryOutput,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      rawMessage: retryMessage,
      retry: {
        first_error: firstValidation.message,
        first_output: firstOutput,
        retry_error: retryValidation.message,
      },
    };
  }

  return {
    output: retryOutput,
    parsed: retryParsed,
    rawMessage: retryMessage,
    retry: {
      first_error: firstValidation.message,
      first_output: firstOutput,
    },
  };
}

export function extractAnthropicText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return part?.type === "text" ? part.text ?? "" : "";
    })
    .join("");
}

export function parseJsonObject(text) {
  const withoutFence = String(text ?? "")
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return {};

  try {
    return JSON.parse(withoutFence.slice(start, end + 1));
  } catch {
    return {};
  }
}

export function validatePageAnalysisOutput(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { message: "Response must be a JSON object.", valid: false };
  }

  if (!Array.isArray(parsed.findings)) {
    return { message: "Response must contain a findings array.", valid: false };
  }

  if (parsed.findings.length > 12) {
    return { message: "Response must contain no more than 12 findings.", valid: false };
  }

  for (const [index, finding] of parsed.findings.entries()) {
    if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
      return { message: `Finding ${index + 1} must be an object.`, valid: false };
    }
    if (!cleanText(finding.source_page_id)) {
      return { message: `Finding ${index + 1} is missing source_page_id.`, valid: false };
    }
    if (!cleanText(finding.rule_id)) {
      return { message: `Finding ${index + 1} is missing rule_id.`, valid: false };
    }
    if (!["low", "medium", "high"].includes(String(finding.severity ?? "").toLowerCase())) {
      return {
        message: `Finding ${index + 1} severity must be low, medium, or high.`,
        valid: false,
      };
    }
    if (!cleanText(finding.evidence) && !cleanText(finding.recommendation)) {
      return {
        message: `Finding ${index + 1} needs evidence or recommendation text.`,
        valid: false,
      };
    }
  }

  return { message: "", valid: true };
}

export function normalizeFindings(
  parsed,
  pageBatch,
  { prefixCategories = {}, selectedRuleIds = null } = {},
) {
  const rawFindings = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.findings)
      ? parsed.findings
      : [];
  const pagesById = new Map(pageBatch.map((page) => [page.sourcePageId, page]));

  return rawFindings
    .map((finding) => {
      const ruleId = cleanText(finding.rule_id);
      if (selectedRuleIds && !selectedRuleIds.has(ruleId)) {
        return null;
      }
      const sourcePageId =
        typeof finding.source_page_id === "string"
          ? finding.source_page_id
          : "";
      const fallbackPage = pageBatch.find(
        (page) => page.pageNumber === Number(finding.page_number ?? finding.page),
      );
      const page = pagesById.get(sourcePageId) ?? fallbackPage ?? pageBatch[0];
      const severity = normalizeSeverity(finding.severity);
      const systemNumber = normalizePositiveInt(
        finding.system_number ?? finding.system,
      );
      const measureNumber = normalizePositiveInt(
        finding.measure_number ?? finding.measure,
      );
      const staffLabel = nullableText(finding.staff_label ?? finding.staff);
      const bboxHint = normalizeBboxHint(finding.bbox_hint ?? finding.bboxHint);

      return {
        asset_filename: page.assetFilename,
        category:
          deriveCategoryFromRuleId(ruleId, {
            prefix_categories: prefixCategories,
          }) || "other",
        confidence:
          typeof finding.confidence === "number" ? finding.confidence : null,
        evidence: cleanText(finding.evidence),
        location_label:
          cleanText(finding.location_label) ||
          cleanText(finding.location) ||
          buildLocationLabel({
            measureNumber,
            pageNumber: page.pageNumber,
            staffLabel,
            systemNumber,
          }),
        metadata_json: {
          bbox_hint: bboxHint,
          measure_number: measureNumber,
          rule_id: ruleId,
          source_page_id: page.sourcePageId,
          staff_label: staffLabel,
          system_number: systemNumber,
        },
        page_number: page.pageNumber,
        recommendation: cleanText(finding.recommendation),
        severity,
      };
    })
    .filter((finding) => finding && (finding.evidence || finding.recommendation));
}

export function toClientFinding(finding, index) {
  return {
    asset_filename: finding.asset_filename,
    bbox_hint: finding.metadata_json?.bbox_hint ?? null,
    category: finding.category,
    confidence: finding.confidence,
    evidence: finding.evidence,
    finding_db_id: finding.finding_db_id ?? finding.id ?? null,
    id: [
      finding.metadata_json?.source_page_id ?? `page-${finding.page_number ?? "unknown"}`,
      finding.metadata_json?.rule_id ?? "finding",
      index + 1,
    ].join(":"),
    location_label: finding.location_label,
    measure_number: finding.metadata_json?.measure_number ?? null,
    page_number: finding.page_number,
    recommendation: finding.recommendation,
    rule_id: finding.metadata_json?.rule_id ?? "",
    severity: finding.severity,
    source_page_id: finding.metadata_json?.source_page_id ?? "",
    staff_label: finding.metadata_json?.staff_label ?? null,
    system_number: finding.metadata_json?.system_number ?? null,
  };
}

export function modelNotesForPage(modelNotes, page) {
  if (!modelNotes) return "";
  if (typeof modelNotes === "string") return modelNotes;
  if (Array.isArray(modelNotes)) return modelNotes.join("\n");
  if (typeof modelNotes === "object") {
    return cleanText(modelNotes[page.sourcePageId] ?? modelNotes[page.pageNumber]);
  }
  return "";
}

export function toJson(value) {
  return value ? JSON.parse(JSON.stringify(value)) : {};
}

function normalizeSeverity(value) {
  const severity = String(value ?? "").toLowerCase();
  return ["low", "medium", "high"].includes(severity) ? severity : "medium";
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function normalizePositiveInt(value) {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeBboxHint(value) {
  if (Array.isArray(value) && value.length === 4) {
    const numbers = value.map((item) => Number(item));
    return numbers.every((number) => Number.isFinite(number))
      ? numbers.map((number) => clamp01(number))
      : null;
  }

  if (value && typeof value === "object") {
    const x = Number(value.x);
    const y = Number(value.y);
    const width = Number(value.width ?? value.w);
    const height = Number(value.height ?? value.h);
    if ([x, y, width, height].every((number) => Number.isFinite(number))) {
      return [x, y, width, height].map((number) => clamp01(number));
    }
  }

  return null;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function buildLocationLabel({
  measureNumber,
  pageNumber,
  staffLabel,
  systemNumber,
}) {
  const parts = [`Page ${pageNumber}`];
  if (systemNumber) parts.push(`system ${systemNumber}`);
  if (measureNumber) parts.push(`measure ${measureNumber}`);
  if (staffLabel) parts.push(staffLabel);
  return parts.join(", ");
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
