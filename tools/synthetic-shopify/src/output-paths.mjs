// @ts-check
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SYNTHETIC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../output",
);

/** @param {string} shopDomain @param {string} runId */
export function runDirectory(shopDomain, runId) {
  return path.join(SYNTHETIC_ROOT, shopDomain, runId);
}

/** @param {string} shopDomain @param {string} runId */
export function manifestPath(shopDomain, runId) {
  return path.join(runDirectory(shopDomain, runId), "manifest.json");
}

/** @param {string} shopDomain @param {string} runId */
export function sourcePath(shopDomain, runId) {
  return path.join(runDirectory(shopDomain, runId), "source-dataset.json");
}

/** @param {string} filePath */
export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** @param {string} filePath @param {unknown} value */
export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(`${filePath}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(`${filePath}.tmp`, filePath);
}

/** @param {string} shopDomain @param {string} runId */
export function readManifest(shopDomain, runId) {
  return readJson(manifestPath(shopDomain, runId));
}
