import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureDir } from "./common.js";

const repoRoot = path.resolve(new URL("../../", import.meta.url).pathname);
const promptRoot = path.join(repoRoot, "system_prompts", "engraving");
const RULE_LINE_PATTERN = /^\s*-\s*([A-Z]{3,5}-\d{2})\s*:\s*(.+)$/gm;

export async function loadRuleRegistry() {
  const manifest = JSON.parse(
    await readFile(path.join(promptRoot, "chapter_manifest.json"), "utf8"),
  );
  const rules = new Map();

  for (const chapter of manifest.chapters ?? []) {
    const file = path.join(promptRoot, chapter.file);
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(RULE_LINE_PATTERN)) {
      const ruleId = match[1];
      rules.set(ruleId, {
        category: manifest.prefix_categories?.[ruleId.split("-")[0]] ?? "other",
        chapter: chapter.tag,
        rule_id: ruleId,
        text: match[2].trim(),
      });
    }
  }

  rules.set("IGNORE", {
    category: "ignore",
    chapter: "eval",
    rule_id: "IGNORE",
    text: "Eval-only excluded region. Predictions matching this location are ignored.",
  });

  return rules;
}

export async function writeRuleCheatSheet(file) {
  const rules = [...(await loadRuleRegistry()).values()].sort((a, b) =>
    a.rule_id.localeCompare(b.rule_id),
  );
  const lines = [
    "# Engraving Rule Cheat Sheet",
    "",
    "Use these `rule_id` values in truth JSON. Use `IGNORE` for regions that should be excluded from scoring.",
    "Use `suppressed: true` for correct-but-unwanted findings. Put hallucinated violations in `known_false_positives`, not in suppressed findings.",
    "",
    "| Rule | Category | Short description |",
    "| --- | --- | --- |",
    ...rules.map((rule) =>
      `| \`${rule.rule_id}\` | ${rule.category} | ${escapeTable(rule.text)} |`,
    ),
    "",
  ];
  await ensureDir(path.dirname(file));
  await writeFile(file, lines.join("\n"));
}

function escapeTable(value) {
  return String(value ?? "").replaceAll("|", "\\|");
}
