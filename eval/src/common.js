import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const repoRoot = path.resolve(new URL("../../", import.meta.url).pathname);
export const evalRoot = path.join(repoRoot, "eval");
export const goldenRoot = path.join(evalRoot, "golden");
export const seededRoot = path.join(evalRoot, "seeded");

export const paths = {
  evalRoot,
  goldenPages: path.join(goldenRoot, "pages"),
  goldenSheets: path.join(goldenRoot, "sheets"),
  goldenTruth: path.join(goldenRoot, "truth"),
  manifest: path.join(goldenRoot, "manifest.json"),
  report: path.join(evalRoot, "report"),
  runs: path.join(evalRoot, "runs"),
  seededPages: path.join(seededRoot, "pages"),
  seededTemplates: path.join(seededRoot, "templates"),
  seededTruth: path.join(seededRoot, "truth"),
};

export function parseArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const [rawKey, inlineValue] = item.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (fallback !== null && error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await writeFile(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  await import("node:fs/promises").then(({ rename }) => rename(`${file}.tmp`, file));
}

export async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function listFiles(dir, predicate = () => true) {
  if (!(await pathExists(dir))) return [];
  const entries = await readdir(dir);
  return entries
    .filter(predicate)
    .sort((a, b) => a.localeCompare(b))
    .map((entry) => path.join(dir, entry));
}

export function inferPageIdFromFile(file) {
  return path.basename(file).replace(/\.[^.]+$/, "");
}

export function inferPageNumber(pageId) {
  const match = String(pageId).match(/(?:^|[_-])p(?:age)?0*(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function inferScoreId(pageId) {
  return String(pageId).replace(/[_-]p(?:age)?0*\d+$/i, "");
}

export function hashText(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

export function hashBuffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function formatRate(value) {
  return Number.isFinite(value) ? value.toFixed(3) : "n/a";
}

export function nowRunId(label = "run") {
  const safeLabel =
    String(label)
      .trim()
      .replace(/[^a-z0-9_-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "run";
  return `${new Date().toISOString().replace(/[:.]/g, "-")}_${safeLabel}`;
}

