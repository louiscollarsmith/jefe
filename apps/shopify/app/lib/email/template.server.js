// @ts-check

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Minimal, dependency-free email template layer.
 *
 * The HTML in ./templates ships as-is from the design handoff — the only edits
 * are `{{var}}` placeholders swapped in for the per-merchant / per-send values
 * (store name, greeting, links, recipient). This module reads those files and
 * fills the placeholders with HTML-escaped values.
 */

/** @type {Map<string, string>} */
const templateCache = new Map();

/**
 * Escape a value for safe interpolation into HTML text or a quoted attribute.
 * Store/merchant names are merchant-controlled, so every interpolated value is
 * escaped by default.
 *
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Replace every `{{key}}` in `template` with the HTML-escaped `vars[key]`.
 * Throws if any placeholder is left unresolved, so a missing variable fails
 * loudly in tests instead of shipping `{{...}}` to a merchant.
 *
 * @param {string} template
 * @param {Record<string, string | number | null | undefined>} vars
 * @returns {string}
 */
export function interpolate(template, vars) {
  const rendered = template.replace(PLACEHOLDER_PATTERN, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      // Leave unknown placeholders in place so the unresolved-check below throws.
      return match;
    }
    const value = vars[key];
    return escapeHtml(value === null || value === undefined ? "" : String(value));
  });

  PLACEHOLDER_PATTERN.lastIndex = 0;
  const leftover = rendered.match(PLACEHOLDER_PATTERN);
  if (leftover) {
    throw new Error(
      `Unresolved email template variable(s): ${leftover.join(", ")}`,
    );
  }
  return rendered;
}

/**
 * Candidate on-disk locations for a template, tried in order. The full source
 * tree is present at runtime in every environment we target:
 *   - `node --test` / `shopify app dev`: resolves next to this module.
 *   - production Docker image (`COPY . .`, cwd `/app`): resolves under cwd.
 *
 * @param {string} filename
 * @returns {string[]}
 */
function templateCandidates(filename) {
  const candidates = [
    fileURLToPath(new URL(`./templates/${filename}`, import.meta.url)),
    path.join(process.cwd(), "app", "lib", "email", "templates", filename),
  ];
  if (process.env.EMAIL_TEMPLATE_DIR) {
    candidates.push(path.join(process.env.EMAIL_TEMPLATE_DIR, filename));
  }
  return candidates;
}

/**
 * Load a raw template HTML file by name (without extension), cached after first
 * read.
 *
 * @param {string} name e.g. "jefe-welcome"
 * @returns {string}
 */
export function loadTemplateHtml(name) {
  const cached = templateCache.get(name);
  if (cached !== undefined) return cached;

  const filename = `${name}.html`;
  const candidates = templateCandidates(filename);
  for (const candidate of candidates) {
    try {
      const html = readFileSync(candidate, "utf8");
      templateCache.set(name, html);
      return html;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `Email template not found: ${filename} (looked in ${candidates.join(", ")})`,
  );
}

/**
 * Render a named template with variables in one call.
 *
 * @param {string} name
 * @param {Record<string, string | number | null | undefined>} vars
 * @returns {string}
 */
export function renderTemplate(name, vars) {
  return interpolate(loadTemplateHtml(name), vars);
}
