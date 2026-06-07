import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const DEFAULT_PROMPT_ROOT_URL = new URL(
  "../../system_prompts/engraving/",
  import.meta.url,
);
const DEFAULT_DETECTION_PROMPT_URL = new URL(
  "../../system_prompts/engraving_instrumentation_detection_system_prompt.md",
  import.meta.url,
);
const RULE_ID_PATTERN = /\b([A-Z]{3,5}-\d{2})\b/g;
const BANNED_PROMPT_TERMS = ["Elaine Gould", "Behind Bars"];
const LOW_CONFIDENCE_THRESHOLD = 0.6;

export async function assembleEngravingPrompt({
  promptRootUrl = DEFAULT_PROMPT_ROOT_URL,
  routing = {},
} = {}) {
  const manifest = await loadManifest(promptRootUrl);
  const normalizedRouting = normalizeRoutingInput(routing, manifest);
  const selectedChapters = selectChapters(manifest, normalizedRouting);
  const chapterBlocks = await Promise.all(
    selectedChapters.map((chapter) => readPromptFile(promptRootUrl, chapter.file)),
  );
  const selectedRuleIds = new Set(extractRuleIds(chapterBlocks.join("\n")));
  const examples = await loadPrunedExamples({
    manifest,
    promptRootUrl,
    selectedRuleIds,
  });
  const base = await readPromptFile(promptRootUrl, manifest.base);
  const reminders = await readPromptFile(promptRootUrl, manifest.reminders);
  const systemPrompt = base
    .replace("{{CHAPTERS}}", chapterBlocks.join("\n\n").trim())
    .replace("{{EXAMPLES}}", examples.trim())
    .replace("{{REMINDERS}}", reminders.trim())
    .trim();

  assertPublicSafePrompt(systemPrompt);

  const fullPrompt = await assembleFullPrompt({ manifest, promptRootUrl });
  const promptHash = hashText(systemPrompt);
  const fullPromptTokens = estimateTokens(fullPrompt);
  const assembledTokens = estimateTokens(systemPrompt);

  return {
    prompt: systemPrompt,
    promptHash,
    routing: normalizedRouting,
    selectedCategories: categoriesForRuleIds(selectedRuleIds, manifest),
    selectedChapters: selectedChapters.map((chapter) => chapter.tag),
    selectedRuleIds: [...selectedRuleIds].sort(),
    tokenEstimate: {
      assembled: assembledTokens,
      drop: Math.max(0, fullPromptTokens - assembledTokens),
      full: fullPromptTokens,
      ratio: fullPromptTokens
        ? Number((assembledTokens / fullPromptTokens).toFixed(3))
        : 1,
    },
  };
}

export async function loadDetectionPrompt(
  detectionPromptUrl = DEFAULT_DETECTION_PROMPT_URL,
) {
  const prompt = await readFile(detectionPromptUrl, "utf8");
  assertPublicSafePrompt(prompt);
  return prompt;
}

export async function loadEngravingManifest(
  promptRootUrl = DEFAULT_PROMPT_ROOT_URL,
) {
  return loadManifest(promptRootUrl);
}

export function normalizeRoutingInput(input = {}, manifest) {
  const instruments = normalizeStringList(input.instruments);
  const explicitFamilies = normalizeStringList(input.instrument_families).map(toKey);
  const detectedFamilies = familiesForInstruments(instruments, manifest);
  const instrumentFamilies = [...new Set([...explicitFamilies, ...detectedFamilies])].sort();
  const docType = normalizeDocType(input.doc_type);
  const confidence =
    typeof input.confidence === "number" && Number.isFinite(input.confidence)
      ? input.confidence
      : null;
  const features = {
    ...manifest.feature_defaults,
    ...normalizeFeatureFlags(input.features),
  };
  const source = input.source ?? "unknown";

  return {
    confidence,
    doc_type: docType,
    features,
    has_staff_system:
      typeof input.has_staff_system === "boolean" ? input.has_staff_system : null,
    instrument_families: instrumentFamilies,
    instruments,
    source,
  };
}

export function deriveCategoryFromRuleId(ruleId, manifest) {
  const prefix = String(ruleId ?? "").split("-")[0];
  return manifest.prefix_categories[prefix] ?? "other";
}

function selectChapters(manifest, routing) {
  return manifest.chapters.filter((chapter) => shouldSelectChapter(chapter, routing));
}

function shouldSelectChapter(chapter, routing) {
  if (chapter.group === "core") return true;

  if (chapter.group === "feature") {
    return shouldIncludeFeature(routing.features[chapter.feature], routing);
  }

  if (chapter.group === "feature_safety") {
    return shouldIncludeFeature(routing.features[chapter.feature], routing, {
      includeWhenUnknown: true,
    });
  }

  if (chapter.group === "instrument") {
    return hasAny(routing.instrument_families, chapter.families);
  }

  if (chapter.group === "doc_type") {
    return chapter.docTypes?.includes(routing.doc_type) ?? false;
  }

  if (chapter.group === "instrument_or_feature") {
    const hasInstrument = hasAny(routing.instrument_families, chapter.families);
    const featureValue = routing.features[chapter.feature];
    if (hasInstrument) return featureValue !== false;
    return featureValue === true;
  }

  return false;
}

function shouldIncludeFeature(value, routing, { includeWhenUnknown = false } = {}) {
  if (value === true) return true;
  if (value === false) return false;
  if (routing.confidence !== null && routing.confidence < LOW_CONFIDENCE_THRESHOLD) {
    return includeWhenUnknown;
  }
  return true;
}

async function loadPrunedExamples({ manifest, promptRootUrl, selectedRuleIds }) {
  const intro = await readPromptFile(promptRootUrl, manifest.examples.intro);
  const exampleBlocks = await Promise.all(
    manifest.examples.files.map((file) => readPromptFile(promptRootUrl, file)),
  );
  const keptExamples = exampleBlocks.filter((example) => {
    const ruleIds = extractRuleIds(example);
    return ruleIds.every((ruleId) => selectedRuleIds.has(ruleId));
  });

  return [intro, ...keptExamples].join("\n\n");
}

async function assembleFullPrompt({ manifest, promptRootUrl }) {
  const chapterBlocks = await Promise.all(
    manifest.chapters.map((chapter) => readPromptFile(promptRootUrl, chapter.file)),
  );
  const selectedRuleIds = new Set(extractRuleIds(chapterBlocks.join("\n")));
  const examples = await loadPrunedExamples({
    manifest,
    promptRootUrl,
    selectedRuleIds,
  });
  const base = await readPromptFile(promptRootUrl, manifest.base);
  const reminders = await readPromptFile(promptRootUrl, manifest.reminders);
  return base
    .replace("{{CHAPTERS}}", chapterBlocks.join("\n\n").trim())
    .replace("{{EXAMPLES}}", examples.trim())
    .replace("{{REMINDERS}}", reminders.trim())
    .trim();
}

async function loadManifest(promptRootUrl) {
  const manifest = JSON.parse(
    await readPromptFile(promptRootUrl, "chapter_manifest.json"),
  );
  return manifest;
}

async function readPromptFile(promptRootUrl, file) {
  return readFile(new URL(file, promptRootUrl), "utf8");
}

function familiesForInstruments(instruments, manifest) {
  const aliases = manifest.instrument_family_aliases ?? {};
  return instruments
    .map((instrument) => aliases[toKey(instrument)])
    .filter(Boolean);
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function normalizeFeatureFlags(features = {}) {
  if (!features || typeof features !== "object") return {};
  return Object.fromEntries(
    Object.entries(features).map(([key, value]) => [
      toKey(key),
      normalizeFeatureValue(value),
    ]),
  );
}

function normalizeFeatureValue(value) {
  if (value === true || value === false || value === null) return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
    if (normalized === "unknown" || normalized === "auto" || normalized === "") {
      return null;
    }
  }
  return null;
}

function normalizeDocType(value) {
  const normalized = toKey(value);
  return ["score", "part"].includes(normalized) ? normalized : "unknown";
}

function hasAny(values, candidates = []) {
  return candidates.some((candidate) => values.includes(candidate));
}

function categoriesForRuleIds(ruleIds, manifest) {
  const categories = [...ruleIds].map((ruleId) =>
    deriveCategoryFromRuleId(ruleId, manifest),
  );
  return [...new Set(categories)].sort();
}

function extractRuleIds(text) {
  return [...text.matchAll(RULE_ID_PATTERN)].map((match) => match[1]);
}

function assertPublicSafePrompt(prompt) {
  const matched = BANNED_PROMPT_TERMS.find((term) => prompt.includes(term));
  if (matched) {
    throw new Error(`Assembled engraving prompt contains a blocked term: ${matched}`);
  }
}

function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function toKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}
