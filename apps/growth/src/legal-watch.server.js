// @ts-check

/**
 * Legal-docs watcher — pure diff logic.
 *
 * Privacy / Terms / DPA must track reality (docs/growth/legal-docs-governance.md).
 * This compares the current declared "legal reality" against the last-reviewed
 * baseline and reports which triggers changed, which documents each change
 * affects, and whether the change is MATERIAL (merchants must be notified) or
 * minor. Pure + dependency-free (node --test). No PII.
 */

/** Which documents/sections each trigger touches. */
export const AFFECTED_DOCS = {
  scopes: ["Privacy §2", "DPA Annex A", "Level-2 attestation"],
  subProcessors: ["DPA Annex B", "Privacy §5"],
  dataRegions: ["Privacy §10", "DPA Annex A"],
  autonomyModes: ["Terms §1/§8", "Privacy §4"],
  dataTypes: ["Privacy §2", "DPA Annex A"],
  retentionModel: ["Privacy §7", "DPA §8"],
};

/** Keys where ANY change is material by default (needs merchant notice). */
const ALWAYS_MATERIAL = new Set(["subProcessors", "dataRegions", "autonomyModes", "dataTypes", "retentionModel"]);

/**
 * @param {string[]|undefined} a
 * @param {string[]|undefined} b
 */
function diffArrays(a, b) {
  const A = new Set(Array.isArray(a) ? a : []);
  const B = new Set(Array.isArray(b) ? b : []);
  return {
    added: [...B].filter((x) => !A.has(x)),
    removed: [...A].filter((x) => !B.has(x)),
  };
}

/**
 * Is a given trigger change material (→ merchants must be notified)?
 * Adding a sub-processor / region / data type / autonomy mode / scope, or any
 * retention change, is material. Removals are reviewable but not, by themselves,
 * merchant-notifiable.
 * @param {string} key
 * @param {{added: string[], removed: string[]}} d
 */
export function isMaterial(key, d) {
  if (key === "retentionModel") return d.added.length > 0 || d.removed.length > 0;
  if (d.added.length > 0 && (ALWAYS_MATERIAL.has(key) || key === "scopes")) return true;
  return false;
}

/**
 * Diff the last-reviewed baseline against the current declared reality.
 * @param {Record<string, any>} baseline
 * @param {Record<string, any>} current
 * @returns {{ changed: boolean, materialChange: boolean, changes: Array<{key:string, added:string[], removed:string[], material:boolean, affects:string[]}> }}
 */
export function detectChanges(baseline, current) {
  const keys = Object.keys(AFFECTED_DOCS);
  const changes = [];
  for (const key of keys) {
    if (key === "retentionModel") {
      const before = baseline?.[key] ?? "";
      const after = current?.[key] ?? "";
      if (before !== after) {
        const d = { added: after ? [after] : [], removed: before ? [before] : [] };
        changes.push({ key, ...d, material: isMaterial(key, d), affects: AFFECTED_DOCS[key] });
      }
      continue;
    }
    const d = diffArrays(baseline?.[key], current?.[key]);
    if (d.added.length || d.removed.length) {
      changes.push({ key, ...d, material: isMaterial(key, d), affects: AFFECTED_DOCS[key] });
    }
  }
  return {
    changed: changes.length > 0,
    materialChange: changes.some((c) => c.material),
    changes,
  };
}

/**
 * Human-readable report.
 * @param {ReturnType<typeof detectChanges>} result
 */
export function formatReport(result) {
  if (!result.changed) return "✅ Legal reality unchanged since last review. No action.";
  const lines = ["⚠️  LEGAL-DOC REVIEW NEEDED — the legal reality changed:", ""];
  for (const c of result.changes) {
    const tag = c.material ? "MATERIAL (notify merchants)" : "review only";
    lines.push(`• ${c.key} [${tag}]`);
    if (c.added.length) lines.push(`    + added:   ${c.added.join(", ")}`);
    if (c.removed.length) lines.push(`    - removed: ${c.removed.join(", ")}`);
    lines.push(`    → update: ${c.affects.join(" · ")}`);
  }
  if (result.materialChange) {
    lines.push("", "A MATERIAL change is present → after updating the docs, notify active merchants (DPA sub-processor changes require prior notice + a right to object).");
  }
  lines.push("", "After review: update the docs, then copy legal-triggers.json → legal-baseline.json to acknowledge.");
  return lines.join("\n");
}

/** Extract the Shopify OAuth scopes from a shopify.app.toml string (drift check). */
export function scopesFromToml(toml) {
  const m = String(toml || "").match(/scopes\s*=\s*"([^"]*)"/);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean);
}
