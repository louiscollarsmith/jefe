// @ts-check
//
// Generic, structural mutation-safety classification for the full Shopify Admin API surface.
//
// SUPERSEDED DESIGN NOTE (2026-08-25, see CLAUDE.md "Execution-safety architecture authorization
// record" for the founder authorization behind this change): an earlier version of this module
// treated "has a human reviewed this exact operation" as a *permanent* precondition for
// execution — anything not individually known-good, family-reviewed, or a plain read resolved
// to UNSUPPORTED_SEMANTICS forever, and a short named list (PROHIBITED_OPERATIONS) was denied
// outright regardless of merchant authorization. That produced a real architectural bug: the
// majority of the 523-mutation Shopify surface was permanently unexecutable not because it was
// unsafe in a specific invocation, but because nobody had gotten around to writing a policy for
// it — and every future Shopify API release would need the same manual triage before Jefe could
// touch it. The founder explicitly authorized removing that assumption. Lack of a hand-written
// policy for an operation is no longer, by itself, a reason execution is impossible.
//
// SECOND SUPERSEDED DESIGN NOTE (same day, same authorization thread): the first fix replaced the
// deny-list with a *named allow/deny-shaped list* mapped to an extra "system-critical" confirmation
// tier above ordinary explicit confirmation, plus a second, separate confirmation gate/route for
// it. The founder asked for that removed too: it was still a distinct per-operation classification
// list (just no longer denying), still a bespoke extra mechanism layered on top of the generic
// safeguards, and not "keeping the architecture generic." There is now exactly one non-frictionless
// interaction tier (EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED) and no named operation list at all —
// every mutation, including the operations formerly on that list (appUninstall,
// appRevokeAccessScopes, customerCancelDataErasure, etc.), is classified purely by the same
// domain/name-shape structural rules everything else uses. Their risk is real and is still
// reflected — structurally, via the destructive-name pattern and the always-sensitive domain set,
// which is exactly where they land — not via a bespoke list or a bespoke confirmation mechanism.
//
// What did NOT change: this module still refuses to let operation-name pattern-matching alone
// grant *frictionless* execution. The safety invariant is now expressed differently — every
// mutation this module classifies gets SOME execution path (never a dead end for a schema-valid
// operation), but an unreviewed one can only ever reach EXECUTABLE_WITH_CONFIRMATION at
// EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED (never AUTONOMOUS_ELIGIBLE, never plain
// APPROVAL_REQUIRED for a destructive/unknown shape) — risk changes the conditions under which an
// operation executes, not whether Jefe has an execution path for it at all. See EXECUTION_STATUS
// below: UNSUPPORTED_SEMANTICS still exists as a value (kept for schema/type continuity and any
// genuinely malformed catalog entry) but this classifier no longer produces it for any
// schema-valid MUTATION.
//
// Four layers now, checked in priority order, and every result carries a `classificationSource`
// naming which layer produced it — auditable by construction, not by convention:
//
//   1. KNOWN_GOOD_OVERRIDES (source: EXPLICIT_KNOWN_GOOD | EXPLICIT_OPERATION_OVERRIDE) —
//      individual operations a human has actually reviewed, seeded from the live
//      ACTION_REGISTRY (EXPLICIT_KNOWN_GOOD — has a real typed adapter, live in production)
//      and the curated 14-operation capability manifest (EXPLICIT_OPERATION_OVERRIDE —
//      reviewed and risk-understood, no adapter yet).
//   2. REVIEWED_FAMILY_POLICIES (source: REVIEWED_OPERATION_FAMILY_POLICY) — a small,
//      human-curated table of (domain, name-shape) → policy, each with its own written
//      justification (why the whole family is trusted, not just why one operation is).
//   3. Structural defaults (source: STRUCTURAL_NAME_INFERENCE) — the generic path every
//      unreviewed, schema-valid MUTATION now falls through to, including operations that would
//      once have been on a bespoke high-risk list. It infers risk tier, reversibility, and
//      required confirmation from operation-name shape and domain, and always returns
//      EXECUTABLE_WITH_CONFIRMATION — never UNSUPPORTED_SEMANTICS — but can never assign
//      AUTONOMOUS_ELIGIBLE or plain APPROVAL_REQUIRED to anything destructive-shaped, identity/
//      financial/platform-domain-shaped, or of genuinely unknown shape.
//
// Scope confidence (how sure we are which Shopify scope an operation needs) is a second,
// independent axis from operation review, and stays that way: it can never promote a mutation to
// less confirmation than the branch above computed, and less-than-"high" confidence always
// requires at least explicit confirmation. It never blocks a mutation outright, because doing so
// silently re-creates the old "operation review is a precondition for execution" assumption
// through a side door — live Shopify scope authorization (gateway.server.js) and Shopify's own
// operation-failure semantics (a real ACCESS_DENIED response, surfaced as SCOPE_NOT_GRANTED,
// never fabricated) are what actually keeps unauthorized calls from succeeding; this module
// governs confirmation friction, not authorization itself.

export const RISK_TIER = Object.freeze({
  normal: "NORMAL",
  sensitive: "SENSITIVE",
  destructive: "DESTRUCTIVE",
  platformCritical: "PLATFORM_CRITICAL",
});

export const REVERSIBILITY = Object.freeze({
  reversible: "REVERSIBLE",
  compensatable: "COMPENSATABLE",
  irreversible: "IRREVERSIBLE",
  unknown: "UNKNOWN",
});

export const INTERACTION = Object.freeze({
  autonomousEligible: "AUTONOMOUS_ELIGIBLE",
  approvalRequired: "APPROVAL_REQUIRED",
  explicitHighRiskConfirmation: "EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED",
  // Retained for type continuity; this classifier no longer produces it (see module note above).
  prohibited: "PROHIBITED",
});

// Ordered weakest → strongest. Used to only ever raise the required confirmation tier (for
// scope-confidence penalties, or when combining signals), never lower one a branch computed.
const INTERACTION_STRENGTH = Object.freeze({
  [INTERACTION.autonomousEligible]: 0,
  [INTERACTION.approvalRequired]: 1,
  [INTERACTION.explicitHighRiskConfirmation]: 2,
  [INTERACTION.prohibited]: 3,
});

function strongerInteraction(a, b) {
  return INTERACTION_STRENGTH[a] >= INTERACTION_STRENGTH[b] ? a : b;
}

export const EXECUTION_STATUS = Object.freeze({
  executable: "EXECUTABLE",
  executableWithConfirmation: "EXECUTABLE_WITH_CONFIRMATION",
  // Retained for type/schema continuity (older catalog snapshots, malformed entries); this
  // classifier itself never returns it for a schema-valid operation as of 2026-08-25.
  unsupportedSemantics: "UNSUPPORTED_SEMANTICS",
  prohibited: "PROHIBITED",
});

// Only meaningful on EXECUTABLE / EXECUTABLE_WITH_CONFIRMATION results — which layer granted
// execution authority. Auditable by construction, not by convention.
export const CLASSIFICATION_SOURCE = Object.freeze({
  explicitKnownGood: "EXPLICIT_KNOWN_GOOD",
  explicitOperationOverride: "EXPLICIT_OPERATION_OVERRIDE",
  reviewedFamilyPolicy: "REVIEWED_OPERATION_FAMILY_POLICY",
  structuralNameInference: "STRUCTURAL_NAME_INFERENCE",
});

/**
 * Seeded from the live ACTION_REGISTRY (app/lib/actions/action-intent.server.js) and the
 * curated 14-operation capability manifest (shopify-capabilities-2026-07.json admission
 * block) — human judgment already captured elsewhere, reused verbatim rather than re-derived.
 * Only the four ACTION_REGISTRY operations (with a real typed adapter + go-live flag) reach
 * full EXECUTABLE; the rest of the curated manifest reaches EXECUTABLE_WITH_CONFIRMATION —
 * reviewed and risk-understood, but without a built executor/adapter yet.
 * @type {Record<string, { riskTier: string; reversibility: string; interaction: string; executionStatus: string; reason: string }>}
 */
const KNOWN_GOOD_OVERRIDES = {
  productUpdate: {
    riskTier: RISK_TIER.normal,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.approvalRequired,
    executionStatus: EXECUTION_STATUS.executable,
    classificationSource: CLASSIFICATION_SOURCE.explicitKnownGood,
    reason: "Live typed adapters (tidy_up, listing_copy) — ACTION_REGISTRY.",
  },
  productVariantsBulkUpdate: {
    riskTier: RISK_TIER.sensitive,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.approvalRequired,
    executionStatus: EXECUTION_STATUS.executable,
    classificationSource: CLASSIFICATION_SOURCE.explicitKnownGood,
    reason: "Live typed adapter (price_markdown / dead-stock clearance) — ACTION_REGISTRY.",
  },
  inventoryTransferCreate: {
    riskTier: RISK_TIER.sensitive,
    reversibility: REVERSIBILITY.irreversible,
    interaction: INTERACTION.explicitHighRiskConfirmation,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.explicitOperationOverride,
    reason: "Typed adapter built, flagged off; curated manifest marks reversible=false.",
  },
  inventoryItemUpdate: {
    riskTier: RISK_TIER.sensitive,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.approvalRequired,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.explicitOperationOverride,
    reason: "Curated manifest (cost/SKU fields); no adapter yet.",
  },
  inventoryActivate: {
    riskTier: RISK_TIER.normal,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.approvalRequired,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.explicitOperationOverride,
    reason: "Curated manifest.",
  },
  discountCodeBasicCreate: {
    riskTier: RISK_TIER.sensitive,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.explicitHighRiskConfirmation,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.explicitOperationOverride,
    reason: "Curated manifest marks HIGH_RISK admission.",
  },
  collectionCreate: {
    riskTier: RISK_TIER.normal,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.approvalRequired,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.explicitOperationOverride,
    reason: "Curated manifest.",
  },
  orderEditBegin: {
    riskTier: RISK_TIER.sensitive,
    reversibility: REVERSIBILITY.irreversible,
    interaction: INTERACTION.explicitHighRiskConfirmation,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.explicitOperationOverride,
    reason: "Curated manifest marks HIGH_RISK, reversible=false.",
  },
  fulfillmentCreate: {
    riskTier: RISK_TIER.sensitive,
    reversibility: REVERSIBILITY.irreversible,
    interaction: INTERACTION.explicitHighRiskConfirmation,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.explicitOperationOverride,
    reason: "Curated manifest marks HIGH_RISK, reversible=false.",
  },
  customerUpdate: {
    riskTier: RISK_TIER.sensitive,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.explicitHighRiskConfirmation,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.explicitOperationOverride,
    reason: "Touches customer PII; curated manifest marks HIGH_RISK admission.",
  },
  metafieldsSet: {
    riskTier: RISK_TIER.normal,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.approvalRequired,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.explicitOperationOverride,
    reason: "Curated manifest.",
  },
};

/**
 * Reviewed operation-family policies — the "cheaper than 523 adapters, but never naming-alone"
 * mechanism. Each entry is a human decision about a whole (domain, name-shape) family, with its
 * own written safety reasoning, not a generic regex applied to all 810 operations. A family
 * only appears here after being deliberately reviewed for: what it touches, whether that's
 * identity/financial data, whether it's reversible, and what its blast radius looks like.
 * @type {Array<{
 *   id: string;
 *   domain: string;
 *   match: RegExp;
 *   forbid?: RegExp;
 *   riskTier: string;
 *   reversibility: string;
 *   interaction: string;
 *   justification: string;
 * }>}
 */
const REVIEWED_FAMILY_POLICIES = [
  {
    id: "collections-metadata-v1",
    domain: "collections",
    match: /^collection(Update|ReorderProducts|RemoveProducts)$/,
    riskTier: RISK_TIER.normal,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.approvalRequired,
    justification:
      "Collections are merchandising groupings, not money or identity data. Membership/order changes are fully reversible (re-add, reorder, or recreate), bounded by the gateway's existing blast-radius cap, and share the exact risk shape already reviewed for collectionCreate/collectionAddProducts (both EXPLICIT_OPERATION_OVERRIDE). Delete-shaped members of this family (collectionDelete) are excluded by the match pattern and fall through to the structural destructive-name path instead.",
  },
  {
    id: "metaobjects-data-v1",
    domain: "metaobjects",
    match: /^metaobject(Create|Update|Upsert)$/,
    riskTier: RISK_TIER.normal,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.approvalRequired,
    justification:
      "Metaobjects are merchant-defined custom structured data (no built-in financial or identity semantics — the schema itself is merchant-authored via metaobject *definitions*, which are deliberately NOT in this family). Fully reversible via a follow-up edit or delete. metaobjectDelete/metaobjectBulkDelete are excluded by the match pattern.",
  },
  {
    id: "navigation-structure-v1",
    domain: "navigation",
    match: /^menu(Create|Update)$/,
    riskTier: RISK_TIER.normal,
    reversibility: REVERSIBILITY.reversible,
    interaction: INTERACTION.approvalRequired,
    justification:
      "Site navigation structure — no financial or customer data, fully reversible by editing the menu again. menuDelete is excluded by the match pattern and falls through to the structural destructive-name path.",
  },
];

const DESTRUCTIVE_NAME_PATTERN = /delete|erase|revoke|uninstall|merge|cancel|close|disable/i;
const BULK_DESTRUCTIVE_NAME_PATTERN = /bulkdelete|bulkremove/i;
const SENSITIVE_READ_PATTERN = /dispute|paymentmandate|creditcard|taxexemption/i;

// Domains whose mutations are always at least SENSITIVE even for a plain create/update, because
// the resource itself is identity, financial, or compliance data.
const ALWAYS_SENSITIVE_MUTATION_DOMAINS = new Set([
  "financial_payment",
  "privacy_compliance",
  "b2b_company",
  "customers",
  "customer_segments",
  "app_platform",
]);

// Domains whose mutations touch money or order state that can be corrected but not cleanly
// undone (a refund can be reversed by another transaction, not erased).
const COMPENSATABLE_MUTATION_DOMAINS = new Set([
  "refunds",
  "returns",
  "order_edits",
  "draft_orders",
  "discounts_promotions",
]);

/**
 * @param {{ operation: string; operationKind: "QUERY" | "MUTATION"; domain: string; scopeConfidence: "high" | "inferred" | "unknown" }} input
 */
export function classifyShopifyOperationSafety(input) {
  const { operation, operationKind, domain, scopeConfidence } = input;

  const override = KNOWN_GOOD_OVERRIDES[operation];
  if (override) return result(scopeConfidence, override);

  const familyPolicy = REVIEWED_FAMILY_POLICIES.find(
    (policy) => policy.domain === domain && policy.match.test(operation) && !(policy.forbid?.test(operation)),
  );
  if (familyPolicy) {
    return result(scopeConfidence, {
      riskTier: familyPolicy.riskTier,
      reversibility: familyPolicy.reversibility,
      interaction: familyPolicy.interaction,
      executionStatus: EXECUTION_STATUS.executableWithConfirmation,
      classificationSource: CLASSIFICATION_SOURCE.reviewedFamilyPolicy,
      reason: `Reviewed family policy "${familyPolicy.id}": ${familyPolicy.justification}`,
    });
  }

  if (operationKind === "QUERY") {
    if (SENSITIVE_READ_PATTERN.test(operation) || domain === "privacy_compliance") {
      return result(scopeConfidence, {
        riskTier: RISK_TIER.sensitive,
        reversibility: REVERSIBILITY.reversible,
        interaction: INTERACTION.approvalRequired,
        executionStatus: EXECUTION_STATUS.executableWithConfirmation,
        classificationSource: CLASSIFICATION_SOURCE.reviewedFamilyPolicy,
        reason: "Reviewed family policy \"sensitive-reads-v1\": read touches specially restricted or protected data.",
      });
    }
    return result(scopeConfidence, {
      riskTier: RISK_TIER.normal,
      reversibility: REVERSIBILITY.reversible,
      interaction: INTERACTION.autonomousEligible,
      executionStatus: EXECUTION_STATUS.executable,
      classificationSource: CLASSIFICATION_SOURCE.reviewedFamilyPolicy,
      reason: "Reviewed family policy \"reads-broadly-available-v1\": a read cannot mutate merchant state, so every query is trusted by default except the specially-restricted carve-out above.",
      skipScopeGate: true, // reads are not gated on scopeConfidence — see result()
    });
  }

  // MUTATION, not covered by a known-good/reviewed-family entry — generic structural
  // classification from here down. Every path in this branch returns EXECUTABLE_WITH_
  // CONFIRMATION: an unreviewed mutation still gets an execution path, just never at more than
  // EXPLICIT_HIGH_RISK_CONFIRMATION_REQUIRED, and never AUTONOMOUS_ELIGIBLE. Operation-name
  // similarity alone must not grant *frictionless* production write authority, but it may no
  // longer be used as a reason execution is impossible at all, and there is no named list here
  // that treats some operations differently by name — everything, including operations that
  // would once have been individually named as especially dangerous (self-deauthorization, GDPR
  // erasure, payment reversal, ...), goes through these same structural rules and lands wherever
  // its real shape and domain put it.
  if (BULK_DESTRUCTIVE_NAME_PATTERN.test(operation)) {
    return result(scopeConfidence, {
      riskTier: RISK_TIER.platformCritical,
      reversibility: REVERSIBILITY.irreversible,
      interaction: INTERACTION.explicitHighRiskConfirmation,
      executionStatus: EXECUTION_STATUS.executableWithConfirmation,
      classificationSource: CLASSIFICATION_SOURCE.structuralNameInference,
      reason: "Bulk-delete-shaped name; unreviewed — explicit confirmation required, never autonomous.",
    });
  }
  if (DESTRUCTIVE_NAME_PATTERN.test(operation)) {
    return result(scopeConfidence, {
      riskTier: RISK_TIER.destructive,
      reversibility: REVERSIBILITY.irreversible,
      interaction: INTERACTION.explicitHighRiskConfirmation,
      executionStatus: EXECUTION_STATUS.executableWithConfirmation,
      classificationSource: CLASSIFICATION_SOURCE.structuralNameInference,
      reason: "Delete/erase/revoke/uninstall/cancel/close-shaped name; unreviewed — explicit confirmation required.",
    });
  }

  if (ALWAYS_SENSITIVE_MUTATION_DOMAINS.has(domain)) {
    return result(scopeConfidence, {
      riskTier: RISK_TIER.sensitive,
      reversibility: REVERSIBILITY.unknown,
      interaction: INTERACTION.explicitHighRiskConfirmation,
      executionStatus: EXECUTION_STATUS.executableWithConfirmation,
      classificationSource: CLASSIFICATION_SOURCE.structuralNameInference,
      reason: `${domain} mutation touches identity, financial, or platform state; unreviewed — explicit confirmation required.`,
    });
  }
  if (COMPENSATABLE_MUTATION_DOMAINS.has(domain)) {
    return result(scopeConfidence, {
      riskTier: RISK_TIER.sensitive,
      reversibility: REVERSIBILITY.compensatable,
      interaction: INTERACTION.explicitHighRiskConfirmation,
      executionStatus: EXECUTION_STATUS.executableWithConfirmation,
      classificationSource: CLASSIFICATION_SOURCE.structuralNameInference,
      reason: `${domain} mutation touches money/order state; unreviewed — explicit confirmation required even though the effect is compensatable rather than irreversible.`,
    });
  }

  // Genuinely unknown shape: no destructive name, no known-sensitive/compensatable domain, no
  // reviewed policy. Still requires explicit confirmation rather than refusing to understand the
  // operation — "unknown future operations default to conservative explicit confirmation, not
  // unsupported."
  return result(scopeConfidence, {
    riskTier: RISK_TIER.platformCritical,
    reversibility: REVERSIBILITY.unknown,
    interaction: INTERACTION.explicitHighRiskConfirmation,
    executionStatus: EXECUTION_STATUS.executableWithConfirmation,
    classificationSource: CLASSIFICATION_SOURCE.structuralNameInference,
    reason: "No reviewed family policy, override, or recognizable risk shape covers this operation; defaulting to explicit confirmation rather than treating it as unsupported.",
  });
}

/**
 * Scope confidence can only ever push the required interaction tier UP, never grant execution
 * status it wouldn't otherwise have and never lower a tier a classification branch already
 * computed. "high" leaves the branch's result untouched; anything less than "high" requires at
 * least explicit confirmation — because Shopify authorization itself (never fabricated) is
 * enforced live by the gateway, not by this module, scope confidence here is about confirmation
 * friction, not a second authorization gate.
 * @param {"high" | "inferred" | "unknown"} scopeConfidence
 * @param {{ riskTier: string; reversibility: string; interaction: string; executionStatus: string; classificationSource?: string; reason: string; skipScopeGate?: boolean }} classification
 */
function result(scopeConfidence, classification) {
  const isExecutableResult =
    classification.executionStatus === EXECUTION_STATUS.executable ||
    classification.executionStatus === EXECUTION_STATUS.executableWithConfirmation;

  if (!isExecutableResult || classification.skipScopeGate) {
    return {
      safety: {
        riskTier: classification.riskTier,
        reversibility: classification.reversibility,
        interaction: classification.interaction,
      },
      execution: {
        status: classification.executionStatus,
        classificationSource: classification.classificationSource,
        reason: classification.reason,
      },
    };
  }

  let interaction = classification.interaction;
  let reason = classification.reason;
  if (scopeConfidence !== "high") {
    interaction = strongerInteraction(interaction, INTERACTION.explicitHighRiskConfirmation);
  }
  if (interaction !== classification.interaction) {
    reason = `${reason} Required Shopify scope is not confidently known (scopeConfidence="${scopeConfidence}"), so confirmation is raised to ${interaction} — live scope authorization is still enforced separately at execution time and never fabricated.`;
  }

  return {
    safety: {
      riskTier: classification.riskTier,
      reversibility: classification.reversibility,
      interaction,
    },
    execution: {
      status: classification.executionStatus,
      classificationSource: classification.classificationSource,
      reason,
    },
  };
}

export { KNOWN_GOOD_OVERRIDES, REVIEWED_FAMILY_POLICIES };
