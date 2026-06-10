import Anthropic from "@anthropic-ai/sdk";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assembleEngravingPrompt,
  loadEngravingManifest,
} from "../../api/lib/engravingPromptAssembler.js";
import {
  buildPageAnalysisMessages,
  createValidatedPageAnalysis,
  getEngravingModelConfig,
  normalizeFindings,
  parseJsonObject,
  summarizeEngravingModelConfig,
  toClientFinding,
  toJson,
} from "../../api/lib/engravingPageAnalysis.js";
import { loadVisionFewShotExamples } from "../../api/lib/engravingVisionFewShots.js";
import {
  ensureDir,
  hashText,
  nowRunId,
  parseArgs,
  paths,
  readJson,
  writeJson,
} from "./common.js";
import { loadPngPageImage, loadTruthRecords } from "./dataset.js";
import { computeEvalResults, renderCsvReport, renderMarkdownReport } from "./metrics.js";
import { loadRuleRegistry } from "./rules.js";

const args = parseArgs();
const label = String(args.label ?? (args.mock ? "mock" : "eval"));
const runId = args.runId ?? nowRunId(label);
const runRoot = path.join(paths.runs, runId);
const rawRoot = path.join(runRoot, "raw");
const normalizedRoot = path.join(runRoot, "normalized");

await ensureDir(rawRoot);
await ensureDir(normalizedRoot);
await ensureDir(paths.report);

const truthRecords = await loadTruthRecords({ includeSeeded: true });
if (!truthRecords.length) {
  throw new Error("No truth files found. Run eval:sheets -- --templates and label at least one page first.");
}

const modelConfig = args.mock
  ? {
      advisor: { enabled: false },
      apiKey: null,
      model: "mock",
    }
  : getEngravingModelConfig();
const anthropic = args.mock ? null : new Anthropic({ apiKey: modelConfig.apiKey });
const promptManifest = await loadEngravingManifest();
const ruleRegistry = await loadRuleRegistry();
const assemblyCache = new Map();
const pageResults = [];

await mapLimit(truthRecords, Number.parseInt(args.concurrency ?? "2", 10) || 2, async (record) => {
  const { assembly, fewShots, routingMetadata } = await promptContextForPage(record.page);
  const pageImage = await loadPngPageImage(record.page.file);
  const pageBatch = [
    {
      assetFilename: record.page.fileName,
      dataUrl: pageImage.dataUrl,
      height: pageImage.height,
      pageNumber: record.page.pageNumber ?? 1,
      sourcePageId: record.page.pageId,
      storagePath: record.page.file,
      width: pageImage.width,
    },
  ];
  const composition = {
    id: record.page.scoreId,
    title: record.page.title,
  };
  const rawFile = path.join(rawRoot, `${record.page.pageId}.json`);
  const normalizedFile = path.join(normalizedRoot, `${record.page.pageId}.json`);
  let raw;

  if (args.mock) {
    raw = await readJson(path.join(paths.runs, String(args.mock), "raw", `${record.page.pageId}.json`));
  } else {
    const messages = [
      ...fewShots.messages,
      ...buildPageAnalysisMessages({
        composition,
        pageBatch,
        routingMetadata,
      }),
    ];
    const response = await createValidatedPageAnalysis({
      advisor: modelConfig.advisor,
      anthropic,
      messages,
      model: modelConfig.model,
      system: assembly.prompt,
    });
    raw = {
      output: response.output,
      parsed: response.parsed,
      retry: response.retry,
      message: toJson(response.rawMessage),
    };
    await writeJson(rawFile, raw);
  }

  const parsed = raw.parsed ?? parseJsonObject(raw.output ?? "");
  const normalized = normalizeFindings(parsed, pageBatch, {
    prefixCategories: promptManifest.prefix_categories,
    selectedRuleIds: new Set(assembly.selectedRuleIds),
  }).map(toClientFinding);
  await writeJson(normalizedFile, {
    page: record.page.pageId,
    predictions: normalized,
  });

  pageResults.push({
    pageId: record.page.pageId,
    predictions: normalized,
    source: record.page.source,
    truth: record.truth,
  });
});

const results = computeEvalResults(pageResults);
const config = {
  advisor: summarizeEngravingModelConfig(modelConfig),
  created_at: new Date().toISOString(),
  label,
  mock_source_run_id: args.mock ? String(args.mock) : null,
  model: modelConfig.model,
  page_count: pageResults.length,
  prompt_hash: hashText([...assemblyCache.values()].map((item) => item.assembly.promptHash).join("\n")),
  registry_version: hashText(JSON.stringify([...ruleRegistry.keys()].sort())),
  run_id: runId,
};

await writeJson(path.join(runRoot, "config.json"), config);
await writeJson(path.join(runRoot, "results.json"), results);
await writeFile(
  path.join(paths.report, `${runId}.md`),
  renderMarkdownReport({ config, results, runId }),
);
await writeFile(path.join(paths.report, `${runId}.csv`), renderCsvReport(results));

console.log(`Eval run complete: ${runId}`);
console.log(`Report: ${path.relative(process.cwd(), path.join(paths.report, `${runId}.md`))}`);

async function promptContextForPage(page) {
  const key = JSON.stringify({
    doc_type: page.docType,
    features: page.features ?? {},
    instruments: page.instruments ?? [],
    source: "manifest",
  });
  if (!assemblyCache.has(key)) {
    const assembly = await assembleEngravingPrompt({
      routing: {
        doc_type: page.docType,
        features: page.features ?? {},
        instruments: page.instruments ?? [],
        source: "manifest",
      },
    });
    const fewShots = await loadVisionFewShotExamples({
      selectedRuleIds: new Set(assembly.selectedRuleIds),
    });
    assemblyCache.set(key, {
      assembly,
      fewShots,
      routingMetadata: {
        doc_type: assembly.routing.doc_type,
        features: assembly.routing.features,
        instrument_families: assembly.routing.instrument_families,
        instruments: assembly.routing.instruments,
        prompt_hash: assembly.promptHash,
        routing_source: assembly.routing.source,
        selected_chapters: assembly.selectedChapters,
        selected_rule_count: assembly.selectedRuleIds.length,
      },
    });
  }
  return assemblyCache.get(key);
}

async function mapLimit(items, limit, worker) {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(workers);
}
