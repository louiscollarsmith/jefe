#!/usr/bin/env node
// Legal-docs watcher — flags when the legal reality has drifted from the
// last-reviewed baseline, and whether merchants must be notified.
//
//   cd apps/growth && npm run legal-watch
//
// Exits 1 when a review is needed (so it can gate CI). It also drift-checks the
// declared scopes against apps/shopify/shopify.app.toml. See
// docs/growth/legal-docs-governance.md.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  detectChanges,
  formatReport,
  scopesFromToml,
  AFFECTED_DOCS,
} from "../src/legal-watch.server.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(dir, "..");
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const baseline = readJson(path.join(root, "legal-baseline.json"));
const current = readJson(path.join(root, "legal-triggers.json"));

const result = detectChanges(baseline, current);
console.log(formatReport(result));

// Scope-drift: do the app's real Shopify scopes match what we've declared?
try {
  const scopes = scopesFromToml(readFileSync(path.resolve(root, "../shopify/shopify.app.toml"), "utf8"));
  if (scopes.length) {
    const declared = new Set(current.scopes || []);
    const inTomlNotDeclared = scopes.filter((s) => !declared.has(s));
    const declaredNotInToml = (current.scopes || []).filter((s) => !scopes.includes(s));
    if (inTomlNotDeclared.length || declaredNotInToml.length) {
      console.log("\n⚠️  Scope drift vs apps/shopify/shopify.app.toml:");
      if (inTomlNotDeclared.length)
        console.log(`    in toml, not declared: ${inTomlNotDeclared.join(", ")} → update legal-triggers.json + review ${AFFECTED_DOCS.scopes.join(" · ")}`);
      if (declaredNotInToml.length)
        console.log(`    declared, not in toml: ${declaredNotInToml.join(", ")}`);
    }
  }
} catch {
  /* toml not reachable from here — skip the drift check */
}

process.exit(result.changed ? 1 : 0);
