import assert from "node:assert/strict";
import { assembleEngravingPrompt } from "../api/lib/engravingPromptAssembler.js";

const RULE_ID_PATTERN = /\b([A-Z]{3,5}-\d{2})\b/g;

const duo = await assembleEngravingPrompt({
  routing: {
    doc_type: "score",
    features: {
      nonstandard_notation: true,
      ornaments_glissandi: true,
      repeats: false,
      tuplets: false,
    },
    instruments: ["violin", "guitar"],
    source: "request",
  },
});

assertIncludes(duo.selectedChapters, "chapter_01_ground_rules");
assertIncludes(duo.selectedChapters, "chapter_13_classical_guitar");
assertIncludes(duo.selectedChapters, "chapter_14_strings");
assertIncludes(
  duo.selectedChapters,
  "chapter_05_grace_notes_arpeggiated_chords_trills_glissandos_and_vibrato",
);
assertIncludes(duo.selectedChapters, "chapter_20_freedom_and_choice");
assertExcludes(duo.selectedChapters, "chapter_07_tuplets");
assertExcludes(duo.selectedChapters, "chapter_08_repeat_signs");
assertExcludes(duo.selectedChapters, "chapter_15_vocal_music");

assertPublicSafe(duo.prompt);
assertRuleIdsLoaded(duo.prompt, duo.selectedRuleIds);
assert.equal(duo.prompt.includes("TEXT-11"), true);
assert.equal(duo.prompt.includes("tempo marking colliding with the staff"), true);
assert.equal(duo.tokenEstimate.drop > 1000, true);
assert.equal(duo.tokenEstimate.ratio < 0.95, true);

const unknown = await assembleEngravingPrompt({
  routing: {
    confidence: 0.3,
    has_staff_system: false,
    source: "detected",
  },
});

assertIncludes(unknown.selectedChapters, "chapter_01_ground_rules");
assertIncludes(unknown.selectedChapters, "chapter_20_freedom_and_choice");
assertExcludes(unknown.selectedChapters, "chapter_05_grace_notes_arpeggiated_chords_trills_glissandos_and_vibrato");
assertExcludes(unknown.selectedChapters, "chapter_07_tuplets");
assertExcludes(unknown.selectedChapters, "chapter_08_repeat_signs");
assertExcludes(unknown.selectedChapters, "chapter_13_classical_guitar");
assertPublicSafe(unknown.prompt);
assertRuleIdsLoaded(unknown.prompt, unknown.selectedRuleIds);

console.log("Engraving assembler checks passed.");

function assertIncludes(items, value) {
  assert.equal(items.includes(value), true, `${value} should be selected`);
}

function assertExcludes(items, value) {
  assert.equal(items.includes(value), false, `${value} should not be selected`);
}

function assertPublicSafe(prompt) {
  assert.equal(prompt.includes("Elaine Gould"), false);
  assert.equal(prompt.includes("Behind Bars"), false);
}

function assertRuleIdsLoaded(prompt, selectedRuleIds) {
  const selected = new Set(selectedRuleIds);
  const promptRuleIds = [...prompt.matchAll(RULE_ID_PATTERN)].map((match) => match[1]);
  const missing = promptRuleIds.filter((ruleId) => !selected.has(ruleId));
  assert.deepEqual([...new Set(missing)].sort(), []);
}
