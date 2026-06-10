import path from "node:path";
import { readFile } from "node:fs/promises";

import {
  inferPageIdFromFile,
  inferPageNumber,
  inferScoreId,
  listFiles,
  pathExists,
  paths,
  readJson,
} from "./common.js";
import { readPngDataUrlAndSize } from "./png.js";
import { normalizeTruth } from "./truth.js";

export async function loadManifest() {
  const manifest = await readJson(paths.manifest, { scores: [] });
  return {
    ...manifest,
    scores: Array.isArray(manifest.scores) ? manifest.scores : [],
  };
}

export async function loadGoldenPageRecords() {
  const manifest = await loadManifest();
  const byPageId = new Map();

  for (const score of manifest.scores) {
    const scoreId = cleanText(score.score_id ?? score.id);
    const pages = Array.isArray(score.pages) ? score.pages : [];
    for (const pageEntry of pages) {
      const page =
        typeof pageEntry === "string" ? { file: pageEntry } : { ...pageEntry };
      const fileName = cleanText(page.file) || `${cleanText(page.page_id ?? page.page)}.png`;
      const pageId =
        cleanText(page.page_id ?? page.page) ||
        inferPageIdFromFile(fileName);
      const expectedFromScore = score.expected_systems_by_page?.[pageId];
      byPageId.set(pageId, {
        docType: cleanText(score.doc_type) || "unknown",
        expectedSystems:
          positiveInt(page.expected_systems ?? page.expected_system_count ?? expectedFromScore),
        features: score.features ?? {},
        file: path.join(paths.goldenPages, fileName),
        fileName,
        instruments: Array.isArray(score.instruments) ? score.instruments : [],
        pageId,
        pageNumber: positiveInt(page.page_number) ?? inferPageNumber(pageId),
        scoreId: scoreId || cleanText(page.score_id) || inferScoreId(pageId),
        source: "golden",
        title: cleanText(score.title) || scoreId || inferScoreId(pageId),
      });
    }
  }

  const pngFiles = await listFiles(paths.goldenPages, (entry) =>
    entry.toLowerCase().endsWith(".png"),
  );
  for (const file of pngFiles) {
    const pageId = inferPageIdFromFile(file);
    if (!byPageId.has(pageId)) {
      const scoreId = inferScoreId(pageId);
      byPageId.set(pageId, {
        docType: "unknown",
        expectedSystems: null,
        features: {},
        file,
        fileName: path.basename(file),
        instruments: [],
        pageId,
        pageNumber: inferPageNumber(pageId),
        scoreId,
        source: "golden",
        title: scoreId,
      });
    }
  }

  return [...byPageId.values()].sort(comparePageRecords);
}

export async function loadSeededPageRecords() {
  const truthFiles = await listFiles(paths.seededTruth, (entry) =>
    entry.toLowerCase().endsWith(".json"),
  );
  const records = [];
  for (const truthFile of truthFiles) {
    const rawTruth = await readJson(truthFile);
    const truth = normalizeTruth(rawTruth, {
      source: truthFile.includes(`${path.sep}seeded${path.sep}`) ? "seeded" : "labeled",
    });
    const pageId = cleanText(truth.page) || inferPageIdFromFile(truthFile);
    const fileName = `${pageId}.png`;
    records.push({
      docType: cleanText(truth.doc_type) || "score",
      expectedSystems: null,
      features: truth.features ?? {},
      file: path.join(paths.seededPages, fileName),
      fileName,
      instruments: Array.isArray(truth.instruments) ? truth.instruments : ["piano"],
      pageId,
      pageNumber: inferPageNumber(pageId),
      scoreId: inferScoreId(pageId),
      source: "seeded",
      title: truth.title || inferScoreId(pageId),
      truthFile,
    });
  }
  return records.sort(comparePageRecords);
}

export async function loadTruthRecords({ includeSeeded = true } = {}) {
  const pageRecords = new Map();
  for (const page of await loadGoldenPageRecords()) {
    pageRecords.set(page.pageId, page);
  }
  if (includeSeeded) {
    for (const page of await loadSeededPageRecords()) {
      pageRecords.set(page.pageId, page);
    }
  }

  const truthFiles = [
    ...(await listFiles(paths.goldenTruth, (entry) => entry.endsWith(".json"))),
    ...(includeSeeded
      ? await listFiles(paths.seededTruth, (entry) => entry.endsWith(".json"))
      : []),
  ];
  const records = [];
  for (const truthFile of truthFiles) {
    const truth = await readJson(truthFile);
    const pageId = cleanText(truth.page) || inferPageIdFromFile(truthFile);
    const page = pageRecords.get(pageId) ?? {
      docType: cleanText(truth.doc_type) || "unknown",
      expectedSystems: null,
      features: truth.features ?? {},
      file: path.join(paths.goldenPages, `${pageId}.png`),
      fileName: `${pageId}.png`,
      instruments: Array.isArray(truth.instruments) ? truth.instruments : [],
      pageId,
      pageNumber: inferPageNumber(pageId),
      scoreId: inferScoreId(pageId),
      source: truth.source === "seeded" ? "seeded" : "golden",
      title: truth.title || inferScoreId(pageId),
    };
    records.push({ page, truth, truthFile });
  }
  return records.sort((a, b) => comparePageRecords(a.page, b.page));
}

export async function loadPngAsDataUrl(file) {
  const bytes = await readFile(file);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

export async function loadPngPageImage(file) {
  return readPngDataUrlAndSize(file);
}

export async function assertPageFilesExist(records) {
  const missing = [];
  for (const record of records) {
    if (!(await pathExists(record.file))) missing.push(record.file);
  }
  return missing;
}

function comparePageRecords(a, b) {
  return (
    a.scoreId.localeCompare(b.scoreId) ||
    (a.pageNumber ?? 0) - (b.pageNumber ?? 0) ||
    a.pageId.localeCompare(b.pageId)
  );
}

function cleanText(value) {
  return String(value ?? "").trim();
}

function positiveInt(value) {
  const number = Number.parseInt(value ?? "", 10);
  return Number.isFinite(number) && number > 0 ? number : null;
}
