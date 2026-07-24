// @ts-check
import fs from "node:fs";

export function loadConfig(filePath) {
  if (!filePath) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
