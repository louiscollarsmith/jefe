// @ts-check

/**
 * ICP triage for the Design Partner pipeline.
 *
 * Pure, dependency-free scoring over `waitlist_signups` rows. A waitlist row
 * gives us only an email + (optional) store URL, so this ranks **chase
 * priority** and lists what still needs human/enrichment qualification — it
 * does NOT claim confirmed ICP fit. The ICP (single-market established DTC,
 * ~$1M–$20M GMV, hands-on operator) is confirmed on a call; see
 * docs/growth/commercial-state.md §2.
 *
 * Signals we can read from the row:
 *  - email class: branded custom domain (stronger) vs freemail (neutral — many
 *    real founders use gmail) vs invalid.
 *  - store presence/kind: own custom domain (more established) vs *.myshopify.com
 *    vs missing (can't evaluate — must ask).
 *  - alignment: email domain === store's custom domain → the signer operates a
 *    branded store (strong positive).
 *
 * Everything else the ICP needs (GMV band, single-vs-multi market, whether the
 * signer is the operator) is NOT in the data, so every lead carries those as
 * open `needs`. This is intentional and honest: the tool triages, the human
 * qualifies.
 */

/** Common free/consumer mailbox providers — a branded domain is a stronger business signal. */
const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com", "gmx.com", "zoho.com", "hey.com",
]);

/**
 * @typedef {object} Signup
 * @property {string} email
 * @property {string|null} [storeUrl]
 * @property {string|null} [source]
 * @property {string|Date|null} [createdAt]
 */

/**
 * @typedef {object} Store
 * @property {"custom"|"myshopify"|"none"|"invalid"} kind
 * @property {string} [domain] Full store domain (e.g. "acme.com" or "acme.myshopify.com").
 * @property {string} [handle] Shop handle where known (e.g. "acme").
 * @property {string} input Original raw value (trimmed).
 */

/** @typedef {"branded"|"freemail"|"invalid"} EmailClass */
/** @typedef {"hot"|"warm"|"low"|"needs_info"|"invalid"} Tier */

/**
 * Lowercased email domain, or "" if not parseable.
 * @param {string} email
 * @returns {string}
 */
export function emailDomain(email) {
  const at = String(email ?? "").trim().toLowerCase();
  const i = at.lastIndexOf("@");
  if (i <= 0 || i === at.length - 1) return "";
  const domain = at.slice(i + 1);
  return domain.includes(".") ? domain : "";
}

/**
 * @param {string} email
 * @returns {EmailClass}
 */
export function classifyEmail(email) {
  const domain = emailDomain(email);
  if (!domain) return "invalid";
  return FREEMAIL.has(domain) ? "freemail" : "branded";
}

/**
 * Normalize the messy free-text store field into a structured store.
 * Handles: "", "acme", "acme.myshopify.com", "acme.com", "https://acme.com/x",
 * "www.ACME.com". A bare token (no dot) is treated as a myshopify handle,
 * because the signup form appends ".myshopify.com".
 * @param {string|null|undefined} raw
 * @returns {Store}
 */
export function normalizeStore(raw) {
  const input = String(raw ?? "").trim();
  if (!input) return { kind: "none", input: "" };

  let s = input.toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "");   // strip protocol
  s = s.replace(/^www\./, "");          // strip www.
  s = s.split("/")[0];                  // drop any path
  s = s.split("?")[0].split("#")[0];    // drop query/hash
  s = s.replace(/\.+$/, "").trim();     // trailing dots
  if (!s) return { kind: "invalid", input };

  if (s.endsWith(".myshopify.com")) {
    const handle = s.slice(0, -".myshopify.com".length);
    if (!handle || !/^[a-z0-9-]+$/.test(handle)) return { kind: "invalid", input };
    return { kind: "myshopify", domain: s, handle, input };
  }

  if (!s.includes(".")) {
    // bare handle → the form's ".myshopify.com" suffix applies
    if (!/^[a-z0-9-]+$/.test(s)) return { kind: "invalid", input };
    return { kind: "myshopify", domain: `${s}.myshopify.com`, handle: s, input };
  }

  // has a dot and isn't myshopify → treat as a custom domain if it looks valid
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) {
    return { kind: "custom", domain: s, input };
  }
  return { kind: "invalid", input };
}

/** @typedef {{ code: string, label: string, weight: number }} Signal */

/**
 * Score one signup for chase priority.
 * @param {Signup} signup
 * @returns {{ email: string, store: Store, emailClass: EmailClass, score: number, tier: Tier, signals: Signal[], needs: string[] }}
 */
export function scoreSignup(signup) {
  const email = String(signup?.email ?? "").trim().toLowerCase();
  const store = normalizeStore(signup?.storeUrl);
  const emailClass = classifyEmail(email);

  /** @type {Signal[]} */
  const signals = [];
  /** @type {string[]} */
  const needs = [];
  let score = 0;

  // Store signal
  if (store.kind === "custom") {
    score += 3;
    signals.push({ code: "store:custom-domain", label: "Own-domain storefront (more established)", weight: 3 });
  } else if (store.kind === "myshopify") {
    score += 2;
    signals.push({ code: "store:myshopify", label: "myshopify.com store", weight: 2 });
  } else if (store.kind === "none") {
    signals.push({ code: "store:missing", label: "No store URL given", weight: 0 });
    needs.push("get-store-url");
  } else {
    signals.push({ code: "store:unparseable", label: "Store URL not parseable", weight: 0 });
    needs.push("get-store-url");
  }

  // Email signal
  if (emailClass === "branded") {
    score += 2;
    signals.push({ code: "email:branded", label: "Branded (custom-domain) email", weight: 2 });
  } else if (emailClass === "freemail") {
    signals.push({ code: "email:freemail", label: "Free mailbox (neutral — common for founders)", weight: 0 });
  } else {
    signals.push({ code: "email:invalid", label: "Email not parseable", weight: 0 });
    needs.push("valid-email");
  }

  // Alignment: branded email whose domain is the custom store domain
  if (store.kind === "custom" && store.domain && emailDomain(email) === store.domain) {
    score += 2;
    signals.push({ code: "aligned:email-matches-store", label: "Email domain matches the store (operator signal)", weight: 2 });
  }

  // Every lead needs these confirmed — they aren't in the waitlist data:
  needs.push("confirm-gmv-1to20m", "confirm-single-market", "confirm-operator");

  /** @type {Tier} */
  let tier;
  if (emailClass === "invalid" && store.kind !== "custom" && store.kind !== "myshopify") {
    tier = "invalid";
  } else if (store.kind === "none" || store.kind === "invalid") {
    tier = "needs_info"; // can't prioritize without a store — must ask
  } else if (score >= 5) {
    tier = "hot";
  } else if (score >= 3) {
    tier = "warm";
  } else {
    tier = "low";
  }

  return { email, store, emailClass, score, tier, signals, needs };
}

/** Sort order for tiers (best chase priority first). */
const TIER_ORDER = { hot: 0, warm: 1, low: 2, needs_info: 3, invalid: 4 };

/**
 * @param {Signup[]} signups
 * @returns {{ total: number, byTier: Record<Tier, number>, ranked: ReturnType<typeof scoreSignup>[] }}
 */
export function rankPipeline(signups) {
  const scored = (Array.isArray(signups) ? signups : []).map(scoreSignup);
  scored.sort((a, b) => {
    const t = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (t !== 0) return t;
    if (b.score !== a.score) return b.score - a.score;
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });

  /** @type {Record<Tier, number>} */
  const byTier = { hot: 0, warm: 0, low: 0, needs_info: 0, invalid: 0 };
  for (const s of scored) byTier[s.tier] += 1;

  return { total: scored.length, byTier, ranked: scored };
}

/**
 * PII-free tallies (no emails / store handles) — safe to log or paste around.
 * @param {ReturnType<typeof rankPipeline>} pipeline
 */
export function summarize(pipeline) {
  const r = pipeline.ranked;
  const count = (/** @type {(s: ReturnType<typeof scoreSignup>) => boolean} */ f) => r.filter(f).length;
  return {
    total: pipeline.total,
    byTier: pipeline.byTier,
    stores: {
      customDomain: count((s) => s.store.kind === "custom"),
      myshopify: count((s) => s.store.kind === "myshopify"),
      missing: count((s) => s.store.kind === "none"),
      unparseable: count((s) => s.store.kind === "invalid"),
    },
    email: {
      branded: count((s) => s.emailClass === "branded"),
      freemail: count((s) => s.emailClass === "freemail"),
      invalid: count((s) => s.emailClass === "invalid"),
    },
    qualifiable: count((s) => s.tier === "hot" || s.tier === "warm"),
  };
}

/**
 * Human-readable report. `withEmails: false` emits only PII-free tallies.
 * @param {ReturnType<typeof rankPipeline>} pipeline
 * @param {{ withEmails?: boolean, limit?: number }} [opts]
 * @returns {string}
 */
export function formatPipeline(pipeline, opts = {}) {
  const sum = summarize(pipeline);
  const lines = [];
  lines.push("Design Partner pipeline — chase priority (triage, not confirmed ICP fit)");
  lines.push("=".repeat(72));
  lines.push(`Total signups: ${sum.total}   Qualifiable (hot+warm): ${sum.qualifiable}`);
  lines.push(
    `Tiers  hot ${sum.byTier.hot}  warm ${sum.byTier.warm}  low ${sum.byTier.low}  ` +
      `needs_info ${sum.byTier.needs_info}  invalid ${sum.byTier.invalid}`,
  );
  lines.push(
    `Stores custom ${sum.stores.customDomain}  myshopify ${sum.stores.myshopify}  ` +
      `missing ${sum.stores.missing}   Email branded ${sum.email.branded}  freemail ${sum.email.freemail}`,
  );

  if (opts.withEmails) {
    lines.push("-".repeat(72));
    const rows = typeof opts.limit === "number" ? pipeline.ranked.slice(0, opts.limit) : pipeline.ranked;
    for (const s of rows) {
      const store = s.store.domain ?? "—";
      lines.push(`[${s.tier.padEnd(10)}] score ${s.score}  ${s.email}  (${store})`);
    }
    if (typeof opts.limit === "number" && pipeline.ranked.length > opts.limit) {
      lines.push(`… ${pipeline.ranked.length - opts.limit} more`);
    }
  } else {
    lines.push("(counts only — run without --counts to list leads)");
  }
  return lines.join("\n");
}
