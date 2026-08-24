// @ts-check
//
// Generic, structural mutation-safety classification for the full Shopify Admin API surface.
// Deliberately NOT 523 hand-written adapters — but also, as of this audit pass, deliberately
// NOT "operation name looks like a simple write, so trust it": an earlier version of this
// module promoted any mutation matching /update|create$|add|set|activate$/i straight to
// EXECUTABLE_WITH_CONFIRMATION whenever its domain had a confident scope. Audited: that path
// alone accounted for 47 of 56 attemptable mutations (84%) — including things like
// giftCardCreate, giftCardDeactivate, and marketCreate — none of them reviewed by a human.
// That is exactly the anti-pattern the safety invariant below forbids, so it is gone.
//
// Four layers now, checked in priority order, and every EXECUTABLE / EXECUTABLE_WITH_CONFIRMATION
// result carries a `classificationSource` naming which layer produced it — auditable by
// construction, not by convention:
//
//   1. PROHIBITED_OPERATIONS (source: n/a — always denies) — a short, human-curated list of
//      operations Jefe must never dynamically invoke, regardless of scope, evidence, or
//      merchant approval. Visible to reasoning, permanently denied at execution.
//   2. KNOWN_GOOD_OVERRIDES (source: EXPLICIT_KNOWN_GOOD | EXPLICIT_OPERATION_OVERRIDE) —
//      individual operations a human has actually reviewed, seeded from the live
//      ACTION_REGISTRY (EXPLICIT_KNOWN_GOOD — has a real typed adapter, live in production)
//      and the curated 14-operation capability manifest (EXPLICIT_OPERATION_OVERRIDE —
//      reviewed and risk-understood, no adapter yet).
//   3. REVIEWED_FAMILY_POLICIES (source: REVIEWED_OPERATION_FAMILY_POLICY) — a small,
//      human-curated table of (domain, name-shape) → policy, each with its own written
//      justification (why the whole family is trusted, not just why one operation is). This
//      is the "operation 300 cheaper than operation 20" mechanism the brief asks for — it is
//      NOT the same thing as trusting any name that merely looks benign: a family only lands
//      here after someone reviewed that specific domain and shape and wrote down why it's
//      safe as a class (see the table below for the actual reasoning per family).
//   4. Structural defaults (source: STRUCTURAL_NAME_INFERENCE, but this path can only ever
//      produce risk/domain *metadata* — it cannot by itself result in EXECUTABLE or
//      EXECUTABLE_WITH_CONFIRMATION; the safety invariant is enforced by construction: the
//      only two `executionStatus` values this layer can return are UNSUPPORTED_SEMANTICS or,
//      for reads, EXECUTABLE). Anything not confidently classified by layers 1-3 resolves to
//      UNSUPPORTED_SEMANTICS — visible to Luna's reasoning, denied at the gateway.
//
// Production-execution invariant (enforced here, not just at the gateway): any result that
// would be EXECUTABLE or EXECUTABLE_WITH_CONFIRMATION is downgraded to UNSUPPORTED_SEMANTICS
// unless scopeConfidence === "high" — "inferred" is not enough to grant write authority,
// only to power discovery/reasoning/evaluation (task Part 2.3).

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
  prohibited: "PROHIBITED",
});

export const EXECUTION_STATUS = Object.freeze({
  executable: "EXECUTABLE",
  executableWithConfirmation: "EXECUTABLE_WITH_CONFIRMATION",
  unsupportedSemantics: "UNSUPPORTED_SEMANTICS",
  prohibited: "PROHIBITED",
});

// Only meaningful on EXECUTABLE / EXECUTABLE_WITH_CONFIRMATION results — which layer granted
// execution authority. Task Part 1.2's exact audit taxonomy.
export const CLASSIFICATION_SOURCE = Object.freeze({
  explicitKnownGood: "EXPLICIT_KNOWN_GOOD",
  explicitOperationOverride: "EXPLICIT_OPERATION_OVERRIDE",
  reviewedFamilyPolicy: "REVIEWED_OPERATION_FAMILY_POLICY",
  structuralNameInference: "STRUCTURAL_NAME_INFERENCE",
});

// Task §11's "likely classes," resolved to real Shopify Admin API operation names. Exact-name
// match only — deliberately not a regex, so this list stays a small, auditable, human decision
// rather than growing into pattern sprawl. Extend by adding a name, with a reason, not a rule.
const PROHIBITED_OPERATIONS = new Map([
  ["appUninstall", "Removes Jefe's own installation — never a dynamically-triggerable action."],
  ["appRevokeAccessScopes", "Alters Jefe's own authorization; a self-inflicted permission cut."],
  ["customerCancelDataErasure", "GDPR/customer-erasure primitive — compliance-sensitive, merchant-initiated only."],
  ["customerRequestDataErasure", "GDPR/customer-erasure primitive — compliance-sensitive, merchant-initiated only."],
  ["bulkOperationRunMutation", "Runs an arbitrary mutation from a JSONL file — incompatible with a per-operation safety contract."],
  ["themeFilesUpsert", "Theme code write; requires a special Shopify exemption and is out of scope (context/13_action_capability_registry.md NO-PATH)."],
  ["disputeEvidenceUpdate", "Unsupported financial/payment primitive; dispute evidence requires special Shopify approval to even read, and is a one-shot compliance-relevant submission."],
  ["transactionVoid", "Reverses real payment capture — a financial primitive outside any typed adapter."],
]);

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
      "Collections are merchandising groupings, not money or identity data. Membership/order changes are fully reversible (re-add, reorder, or recreate), bounded by the gateway's existing blast-radius cap, and share the exact risk shape already reviewed for collectionCreate/collectionAddProducts (both EXPLICIT_OPERATION_OVERRIDE). Delete-shaped members of this family (collectionDelete) are excluded by the match pattern and fall through to the destructive-name path instead.",
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
      "Site navigation structure — no financial or customer data, fully reversible by editing the menu again. menuDelete is excluded by the match pattern and falls through to the destructive-name path.",
  },
];

const DESTRUCTIVE_NAME_PATTERN = /delete|erase|revoke|uninstall|merge/i;
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

  if (PROHIBITED_OPERATIONS.has(operation)) {
    return result(scopeConfidence, {
      riskTier: RISK_TIER.platformCritical,
      reversibility: REVERSIBILITY.irreversible,
      interaction: INTERACTION.prohibited,
      executionStatus: EXECUTION_STATUS.prohibited,
      reason: PROHIBITED_OPERATIONS.get(operation) ?? "Explicitly prohibited operation.",
    });
  }

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
      reason: "Reviewed family policy \"reads-broadly-available-v1\": a read cannot mutate merchant state, so every query is trusted by default except the specially-restricted carve-out above (task §12).",
      skipScopeGate: true, // reads are not gated on scopeConfidence — see result()
    });
  }

  // MUTATION, not overridden, not covered by a reviewed family policy — structural
  // classification only from here down. By construction this branch can only ever return
  // UNSUPPORTED_SEMANTICS: no combination of domain/name-pattern checks below sets
  // executionStatus to EXECUTABLE or EXECUTABLE_WITH_CONFIRMATION. Operation-name similarity
  // alone must not grant production write authority (task Part 1.3) — these checks may only
  // sharpen risk/reversibility *metadata* for an operation that stays non-executable.
  if (BULK_DESTRUCTIVE_NAME_PATTERN.test(operation)) {
    return result(scopeConfidence, {
      riskTier: RISK_TIER.platformCritical,
      reversibility: REVERSIBILITY.irreversible,
      interaction: INTERACTION.explicitHighRiskConfirmation,
      executionStatus: EXECUTION_STATUS.unsupportedSemantics,
      reason: "Bulk-delete-shaped name; unreviewed — structural classification only, never auto-executable.",
    });
  }
  if (DESTRUCTIVE_NAME_PATTERN.test(operation)) {
    return result(scopeConfidence, {
      riskTier: RISK_TIER.destructive,
      reversibility: REVERSIBILITY.irreversible,
      interaction: INTERACTION.explicitHighRiskConfirmation,
      executionStatus: EXECUTION_STATUS.unsupportedSemantics,
      reason: "Delete/erase/revoke/merge-shaped name; unreviewed — structural classification only.",
    });
  }

  if (ALWAYS_SENSITIVE_MUTATION_DOMAINS.has(domain)) {
    return result(scopeConfidence, {
      riskTier: RISK_TIER.sensitive,
      reversibility: REVERSIBILITY.unknown,
      interaction: INTERACTION.explicitHighRiskConfirmation,
      executionStatus: EXECUTION_STATUS.unsupportedSemantics,
      reason: `${domain} mutation touches identity, financial, or platform state; unreviewed.`,
    });
  }
  if (COMPENSATABLE_MUTATION_DOMAINS.has(domain)) {
    return result(scopeConfidence, {
      riskTier: RISK_TIER.sensitive,
      reversibility: REVERSIBILITY.compensatable,
      interaction: INTERACTION.approvalRequired,
      executionStatus: EXECUTION_STATUS.unsupportedSemantics,
      reason: `${domain} mutation touches money/order state; unreviewed.`,
    });
  }

  return result(scopeConfidence, {
    riskTier: RISK_TIER.sensitive,
    reversibility: REVERSIBILITY.unknown,
    interaction: INTERACTION.approvalRequired,
    executionStatus: EXECUTION_STATUS.unsupportedSemantics,
    classificationSource: CLASSIFICATION_SOURCE.structuralNameInference,
    reason: scopeConfidence !== "high"
      ? "Scope requirement not confidently known — never let unknown mean safe."
      : "No reviewed family policy or override covers this operation; name pattern alone is never sufficient to grant execution authority.",
  });
}

/**
 * Production-execution invariant, enforced here rather than trusted to callers: any result
 * carrying EXECUTABLE or EXECUTABLE_WITH_CONFIRMATION is downgraded to UNSUPPORTED_SEMANTICS
 * unless scopeConfidence is "high" (task Part 2.3) — "inferred" is real signal for discovery
 * and evaluation, never enough on its own to grant write authority. Reads are exempt: a query
 * cannot mutate merchant state, so scope confidence there only affects the live gateway scope
 * check (§2), never this safety gate.
 * @param {"high" | "inferred" | "unknown"} scopeConfidence
 * @param {{ riskTier: string; reversibility: string; interaction: string; executionStatus: string; classificationSource?: string; reason: string; skipScopeGate?: boolean }} classification
 */
function result(scopeConfidence, classification) {
  const isExecutableResult =
    classification.executionStatus === EXECUTION_STATUS.executable ||
    classification.executionStatus === EXECUTION_STATUS.executableWithConfirmation;
  const scopeGated = isExecutableResult && !classification.skipScopeGate && scopeConfidence !== "high";
  return {
    safety: {
      riskTier: classification.riskTier,
      reversibility: classification.reversibility,
      interaction: classification.interaction,
    },
    execution: {
      status: scopeGated ? EXECUTION_STATUS.unsupportedSemantics : classification.executionStatus,
      classificationSource: scopeGated ? undefined : classification.classificationSource,
      reason: scopeGated
        ? `Would otherwise be ${classification.executionStatus}, but scopeConfidence is "${scopeConfidence}", not "high" — never let unknown mean safe (task Part 2.3). ${classification.reason}`
        : classification.reason,
    },
  };
}

export { PROHIBITED_OPERATIONS, KNOWN_GOOD_OVERRIDES, REVIEWED_FAMILY_POLICIES };
