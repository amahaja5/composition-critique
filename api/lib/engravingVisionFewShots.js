import { readFile } from "node:fs/promises";

export const DEFAULT_VISION_EXAMPLES_ROOT_URL = new URL(
  "../../system_prompts/engraving/vision_examples/",
  import.meta.url,
);

export async function loadVisionFewShotExamples({
  examplesRootUrl = DEFAULT_VISION_EXAMPLES_ROOT_URL,
  selectedRuleIds = [],
} = {}) {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", examplesRootUrl), "utf8"),
  );
  const examples = Array.isArray(manifest.examples) ? manifest.examples : [];
  const loadedRuleIds =
    selectedRuleIds instanceof Set ? selectedRuleIds : new Set(selectedRuleIds);
  const messages = [];
  const citedRuleIds = new Set();
  const exampleIds = [];
  const skippedExamples = [];

  for (const [index, example] of examples.entries()) {
    const normalized = normalizeVisionFewShotExample(example, index);
    const imageData = await readFile(new URL(normalized.image, examplesRootUrl));
    const gold = await loadVisionFewShotGold(normalized.gold, examplesRootUrl);
    const ruleIds = extractGoldRuleIds(gold);
    const unloadedRuleIds = ruleIds.filter((ruleId) => !loadedRuleIds.has(ruleId));
    if (unloadedRuleIds.length) {
      skippedExamples.push({
        id: normalized.id,
        unloaded_rule_ids: unloadedRuleIds,
      });
      continue;
    }

    for (const ruleId of ruleIds) {
      citedRuleIds.add(ruleId);
    }

    exampleIds.push(normalized.id);
    messages.push({
      role: "user",
      content: [
        {
          type: "text",
          text: [
            `source_page_id: ${normalized.sourcePageId}`,
            normalized.prompt,
          ].join("\n"),
        },
        buildAnthropicBase64ImageBlock({
          data: imageData.toString("base64"),
          mediaType: normalized.mediaType,
        }),
      ],
    });

    messages.push({
      role: "assistant",
      content: [
        {
          ...(index === examples.length - 1
            ? { cache_control: { type: "ephemeral" } }
            : {}),
          text: JSON.stringify(gold, null, 2),
          type: "text",
        },
      ],
    });
  }

  return {
    messages,
    metadata: {
      cache: {
        enabled: messages.length > 0,
        scope: "vision_few_shot_prefix",
        type: "ephemeral",
      },
      cited_rule_ids: [...citedRuleIds].sort(),
      count: examples.length,
      example_ids: exampleIds,
      included_count: exampleIds.length,
      skipped_examples: skippedExamples,
    },
  };
}

export function buildAnthropicBase64ImageBlock({ data, mediaType }) {
  return {
    source: {
      data,
      media_type: mediaType,
      type: "base64",
    },
    type: "image",
  };
}

function normalizeVisionFewShotExample(example, index) {
  const image = cleanText(example?.image);
  const gold = example?.gold ?? example?.gold_label ?? example?.label;
  const goldPath = typeof gold === "string" ? cleanText(gold) : "";
  if (!image) {
    throw new Error(`Few-shot example ${index + 1} is missing an image path.`);
  }
  if (!goldPath && (!gold || typeof gold !== "object")) {
    throw new Error(`Few-shot example ${image} is missing a gold JSON label.`);
  }

  const id = cleanText(example?.id) || inferVisionExampleId(image, index);
  return {
    gold: goldPath || gold,
    id,
    image,
    mediaType: cleanText(example?.media_type) || inferImageMediaType(image),
    prompt: cleanText(example?.prompt) || "Critique this engraving.",
    sourcePageId: cleanText(example?.source_page_id) || `fewshot_${id}`,
  };
}

async function loadVisionFewShotGold(gold, examplesRootUrl) {
  const parsed =
    gold && typeof gold === "object"
      ? gold
      : JSON.parse(await readFile(new URL(gold, examplesRootUrl), "utf8"));
  return normalizeGoldOutput(parsed);
}

function extractGoldRuleIds(gold) {
  const findings = Array.isArray(gold?.findings) ? gold.findings : [];
  return findings
    .map((finding) => cleanText(finding.rule_id))
    .filter(Boolean);
}

function inferVisionExampleId(image, index) {
  const fileName = image.split(/[\\/]/).pop() || `example_${index + 1}`;
  return (
    fileName
      .replace(/\.[^.]+$/, "")
      .replace(/[^a-z0-9]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .toLowerCase() || `example_${index + 1}`
  );
}

function inferImageMediaType(image) {
  const extension = image.split(".").pop()?.toLowerCase();
  const mediaTypes = {
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  const mediaType = mediaTypes[extension];
  if (!mediaType) {
    throw new Error(`Few-shot image ${image} has an unsupported image type.`);
  }
  return mediaType;
}

function normalizeGoldOutput(gold) {
  const findings = Array.isArray(gold?.findings) ? gold.findings : [];
  return {
    findings: findings.map((finding) => ({
      source_page_id: cleanText(finding.source_page_id),
      page_number: normalizeNullableInt(finding.page_number),
      system_number: normalizeNullableInt(finding.system_number ?? finding.system),
      measure_number: normalizeNullableInt(finding.measure_number ?? finding.measure),
      staff_label: nullableText(finding.staff_label ?? finding.staff),
      location_label: nullableText(finding.location_label),
      rule_id: cleanText(finding.rule_id),
      severity: cleanText(finding.severity) || "medium",
      evidence: cleanText(finding.evidence),
      recommendation: cleanText(finding.recommendation),
      confidence:
        typeof finding.confidence === "number" && Number.isFinite(finding.confidence)
          ? finding.confidence
          : 0.9,
      bbox_hint: normalizeNullableBbox(finding.bbox_hint ?? finding.bboxHint),
    })),
    model_notes: cleanText(gold?.model_notes),
  };
}

function normalizeNullableInt(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeNullableBbox(value) {
  if (Array.isArray(value) && value.length === 4) {
    const numbers = value.map((item) => Number(item));
    return numbers.every((number) => Number.isFinite(number)) ? numbers : null;
  }
  return null;
}

function nullableText(value) {
  const text = cleanText(value);
  return text || null;
}

function cleanText(value) {
  return String(value ?? "").trim();
}
