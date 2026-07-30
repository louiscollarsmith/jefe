import { test } from "node:test";
import assert from "node:assert/strict";

import {
  detectChanges,
  isMaterial,
  formatReport,
  scopesFromToml,
  AFFECTED_DOCS,
} from "../src/legal-watch.server.js";

const BASE = {
  scopes: ["read_orders", "read_products"],
  subProcessors: ["Neon", "Railway"],
  dataRegions: ["UK", "EU"],
  autonomyModes: ["advisory"],
  dataTypes: ["orders"],
  retentionModel: "raw-at-rest",
};

test("no change → clean", () => {
  const r = detectChanges(BASE, { ...BASE });
  assert.equal(r.changed, false);
  assert.equal(r.materialChange, false);
  assert.match(formatReport(r), /unchanged/i);
});

test("adding a sub-processor is a MATERIAL change affecting the DPA", () => {
  const r = detectChanges(BASE, { ...BASE, subProcessors: ["Neon", "Railway", "Klaviyo"] });
  assert.equal(r.changed, true);
  assert.equal(r.materialChange, true);
  const c = r.changes.find((x) => x.key === "subProcessors");
  assert.deepEqual(c.added, ["Klaviyo"]);
  assert.equal(c.material, true);
  assert.ok(c.affects.some((d) => d.includes("DPA")));
});

test("autonomy-mode change (advisory → two-mode) is material, hits Terms + Privacy", () => {
  const r = detectChanges(BASE, { ...BASE, autonomyModes: ["approve-execute", "autonomous"] });
  const c = r.changes.find((x) => x.key === "autonomyModes");
  assert.deepEqual(c.added.sort(), ["approve-execute", "autonomous"]);
  assert.deepEqual(c.removed, ["advisory"]);
  assert.equal(c.material, true);
  assert.deepEqual(AFFECTED_DOCS.autonomyModes, c.affects);
});

test("removing a scope is a change but not, by itself, merchant-notifiable", () => {
  const r = detectChanges(BASE, { ...BASE, scopes: ["read_orders"] });
  const c = r.changes.find((x) => x.key === "scopes");
  assert.deepEqual(c.removed, ["read_products"]);
  assert.equal(c.material, false); // removal only
  assert.equal(r.changed, true);
});

test("retention change is material", () => {
  const r = detectChanges(BASE, { ...BASE, retentionModel: "trimmed-at-ingest" });
  assert.equal(isMaterial("retentionModel", { added: ["x"], removed: ["y"] }), true);
  assert.equal(r.materialChange, true);
});

test("scopesFromToml parses the scopes line", () => {
  const toml = 'name = "x"\n[access_scopes]\nscopes = "read_orders,write_orders, read_products"\n';
  assert.deepEqual(scopesFromToml(toml), ["read_orders", "write_orders", "read_products"]);
  assert.deepEqual(scopesFromToml("no scopes here"), []);
});
