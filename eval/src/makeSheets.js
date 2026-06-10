import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { detectScoreGeometryFromPixels } from "../../src/lib/scoreGeometry.js";
import {
  ensureDir,
  hashText,
  parseArgs,
  pathExists,
  paths,
  repoRoot,
  writeJson,
} from "./common.js";
import { loadGoldenPageRecords } from "./dataset.js";
import { readPngPixels, writeSheetPng } from "./png.js";
import { writeRuleCheatSheet } from "./rules.js";

const args = parseArgs();

await ensureDir(paths.goldenPages);
await ensureDir(paths.goldenSheets);
await ensureDir(paths.goldenTruth);

const pages = await loadGoldenPageRecords();
const geometrySourceHash = await loadGeometrySourceHash();
const review = [
  "# Sheet Review",
  "",
  "Review these items before labeling. If system numbering is wrong, fix geometry and regenerate sheets before editing truth JSON.",
  "",
];

for (const page of pages) {
  if (!(await pathExists(page.file))) {
    review.push(`- ${page.pageId}: missing PNG at \`${path.relative(paths.evalRoot, page.file)}\`.`);
    continue;
  }

  const { data, height, width } = await readPngPixels(page.file);
  const geometry = detectScoreGeometryFromPixels({
    data,
    height,
    width,
  });
  const sheetName = `${page.pageId}.geom-${geometrySourceHash}.png`;
  const sheetFile = path.join(paths.goldenSheets, sheetName);
  await writeSheetPng({ file: page.file, geometry, outFile: sheetFile, page });

  if (!geometry.systems.length) {
    review.push(`- ${page.pageId}: no systems detected.`);
  }
  if (page.expectedSystems && page.expectedSystems !== geometry.systems.length) {
    review.push(
      `- ${page.pageId}: expected ${page.expectedSystems} systems, detected ${geometry.systems.length}.`,
    );
  }

  if (args.templates) {
    const templateFile = path.join(paths.goldenTruth, `${page.pageId}.json`);
    if (args.overwrite || !(await pathExists(templateFile))) {
      await writeJson(templateFile, {
        page: page.pageId,
        labeler: "",
        labeled_at: new Date().toISOString().slice(0, 10),
        exhaustive: false,
        geometry_output_hash: hashText(JSON.stringify(geometry)).slice(0, 12),
        geometry_source_hash: geometrySourceHash,
        findings: [],
        known_false_positives: [],
        sheet_file: sheetName,
      });
    }
  }
}

if (review.length === 4) {
  review.push("- No review issues found.");
}
await writeFile(path.join(paths.goldenSheets, "REVIEW.md"), `${review.join("\n")}\n`);
await writeRuleCheatSheet(path.join(paths.goldenSheets, "RULE_CHEAT_SHEET.md"));

console.log(`Generated ${pages.length} labeling sheet${pages.length === 1 ? "" : "s"}.`);

async function loadGeometrySourceHash() {
  const files = [
    path.join(repoRoot, "src", "lib", "scoreGeometry.js"),
    path.join(repoRoot, "src", "lib", "coords.js"),
  ];
  const text = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return hashText(text.join("\n")).slice(0, 12);
}
