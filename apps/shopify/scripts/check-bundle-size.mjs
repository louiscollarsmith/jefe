#!/usr/bin/env node
// Non-blocking bundle-size guard. Compares app-owned client chunks' gzip size to a
// committed budget (bundle-budget.json) and flags regressions — protects the app._index
// perf-decomposition from a heavy module silently creeping back into the route chunk.
// Exits 1 on a regression (CI surfaces it); wired continue-on-error until it's proven.
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const assetsDir = join(appDir, "build", "client", "assets");
const budget = JSON.parse(readFileSync(join(appDir, "bundle-budget.json"), "utf8"));

let files;
try {
  files = readdirSync(assetsDir);
} catch {
  console.error(`bundle-size: no build output at build/client/assets — run \`npm run build\` first. Skipping.`);
  process.exit(0);
}

/** The single `<prefix>-<hash>.js` chunk for a name (Vite hashes each chunk). */
function chunkGzipKb(prefix) {
  const match = files.find((f) => f.startsWith(`${prefix}-`) && f.endsWith(".js"));
  if (!match) return null;
  const buf = readFileSync(join(assetsDir, match));
  return { file: match, kb: gzipSync(buf).length / 1024 };
}

let failed = false;
const lines = [];
for (const [chunk, maxKb] of Object.entries(budget.gzipKb ?? {})) {
  const got = chunkGzipKb(chunk);
  if (!got) {
    lines.push(`  ?  ${chunk}: chunk not found (renamed/removed? update bundle-budget.json)`);
    continue;
  }
  const over = got.kb > maxKb;
  if (over) failed = true;
  lines.push(`  ${over ? "✗" : "✓"} ${chunk}: ${got.kb.toFixed(2)} kB gzip (budget ${maxKb}) — ${got.file}`);
}

console.log("Bundle-size guard (gzip):");
console.log(lines.join("\n"));
if (failed) {
  console.error(
    "\n✗ A tracked chunk exceeded its budget. Investigate the regression (a heavy static import?),\n" +
      "  or raise the budget in bundle-budget.json in the same change if the growth is intended.",
  );
  process.exit(1);
}
console.log("\n✓ All tracked chunks within budget.");
