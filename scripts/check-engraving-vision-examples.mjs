import { readFile } from "node:fs/promises";

import { assembleEngravingPrompt } from "../api/lib/engravingPromptAssembler.js";
import {
  DEFAULT_VISION_EXAMPLES_ROOT_URL,
  loadVisionFewShotExamples,
} from "../api/lib/engravingVisionFewShots.js";

const manifest = JSON.parse(
  await readFile(new URL("manifest.json", DEFAULT_VISION_EXAMPLES_ROOT_URL), "utf8"),
);
const examples = Array.isArray(manifest.examples) ? manifest.examples : [];
if (!examples.length) {
  throw new Error("Vision few-shot manifest must contain at least one example.");
}

const allRulesAssembly = await assembleEngravingPrompt({
  routing: {
    doc_type: "part",
    features: {
      electroacoustic_or_graphic: true,
      lyrics: true,
      nonstandard_notation: true,
      ornaments_glissandi: true,
      repeats: true,
      tuplets: true,
    },
    instruments: [
      "violin",
      "guitar",
      "piano",
      "harp",
      "flute",
      "percussion",
      "voice",
      "electronics",
    ],
    source: "request",
  },
});
const fallbackAssembly = await assembleEngravingPrompt({
  routing: {
    source: "fallback",
  },
});
const allRuleIds = new Set(allRulesAssembly.selectedRuleIds);
const fallbackRuleIds = new Set(fallbackAssembly.selectedRuleIds);
let emptyGoldCount = 0;

for (const [index, example] of examples.entries()) {
  const image = stringField(example.image);
  const gold = example.gold;
  if (!image) {
    throw new Error(`Example ${index + 1} is missing image.`);
  }
  if (!gold) {
    throw new Error(`Example ${image} is missing gold.`);
  }

  const imageBytes = await readFile(new URL(image, DEFAULT_VISION_EXAMPLES_ROOT_URL));
  assertSupportedImage(image, imageBytes);

  const goldJson =
    typeof gold === "object"
      ? gold
      : JSON.parse(
          await readFile(new URL(stringField(gold), DEFAULT_VISION_EXAMPLES_ROOT_URL), "utf8"),
        );
  const findings = Array.isArray(goldJson.findings) ? goldJson.findings : null;
  if (!findings) {
    throw new Error(`Gold label for ${image} must contain a findings array.`);
  }
  if (!findings.length) emptyGoldCount += 1;

  for (const finding of findings) {
    const ruleId = stringField(finding.rule_id);
    if (!ruleId) {
      throw new Error(`Gold finding for ${image} is missing rule_id.`);
    }
    if (!allRuleIds.has(ruleId)) {
      throw new Error(`Gold finding for ${image} cites unknown rule ${ruleId}.`);
    }
  }
}

if (!emptyGoldCount) {
  throw new Error("Expected at least one clean calibration example with no findings.");
}

const fewShots = await loadVisionFewShotExamples({ selectedRuleIds: fallbackRuleIds });
const expectedMessageCount = fewShots.metadata.included_count * 2;
if (fewShots.messages.length !== expectedMessageCount) {
  throw new Error(
    `Expected ${expectedMessageCount} few-shot messages, got ${fewShots.messages.length}.`,
  );
}
if (!fewShots.metadata.included_count) {
  throw new Error("Expected at least one few-shot example for fallback routing.");
}
for (let index = 0; index < fewShots.messages.length; index += 2) {
  if (fewShots.messages[index].role !== "user") {
    throw new Error(`Few-shot message ${index} must be a user image turn.`);
  }
  if (fewShots.messages[index + 1]?.role !== "assistant") {
    throw new Error(`Few-shot message ${index + 1} must be an assistant gold turn.`);
  }
}

const lastMessage = fewShots.messages[fewShots.messages.length - 1];
const lastTextBlock = lastMessage?.content?.find((block) => block.type === "text");
if (lastTextBlock?.cache_control?.type !== "ephemeral") {
  throw new Error("Final few-shot assistant turn must have an ephemeral cache breakpoint.");
}

console.log(`Vision few-shot checks passed for ${examples.length} examples.`);

function assertSupportedImage(image, bytes) {
  if (image.endsWith(".png") && hasSignature(bytes, [0x89, 0x50, 0x4e, 0x47])) return;
  if (
    (image.endsWith(".jpg") || image.endsWith(".jpeg")) &&
    hasSignature(bytes, [0xff, 0xd8, 0xff])
  ) {
    return;
  }
  if (image.endsWith(".gif") && bytes.subarray(0, 3).toString("ascii") === "GIF") return;
  if (
    image.endsWith(".webp") &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return;
  }
  throw new Error(`Few-shot image ${image} is not a supported image file.`);
}

function hasSignature(bytes, signature) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function stringField(value) {
  return typeof value === "string" ? value.trim() : "";
}
