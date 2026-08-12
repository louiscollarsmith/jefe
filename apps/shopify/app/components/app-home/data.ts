// Prop shapes for the 13a app home + the mappers that make the redesign honest on a
// real (thin) store. These match the loader shapes daily-home.tsx renders today, plus
// a small set of OPTIONAL fields the memory pipeline (chat 9) can populate to unlock
// the two Memory product gaps. When those fields are absent we fall back to what today's
// data can honestly support — never to the prototype's demo numbers.

export type Metrics = {
  orders: number;
  products: number;
  variants: number;
  skus: number;
  customers: number;
  revenue: number | null;
  monthlyRevenue: number | null;
  currency: string;
} | null;

// Today's belief shape + optional 13a fields. The optional fields are the contract for
// chat 9: when present they drive the plain-English statement (gap #1) and the
// provenance + authorship (gap #2). Until then, the mapper degrades honestly.
export type MemoryBelief = {
  id: string;
  title: string;
  value: string;
  status: string; // "observed" | "merchant_confirmed" | "merchant_corrected" | "needs_input" | ...
  evidenceSummary: string | null;
  // Optional — populated by the memory pipeline when available:
  statement?: string | null; // plain-English rendering, e.g. "You sell in bursts, ~8 days a month."
  sourceLine?: string | null; // provenance, e.g. "from 46 orders · rechecked today"
  authorship?: "merchant" | "jefe" | null; // who said it
  confirmState?: "settled" | "unsure" | "blocked" | null; // drives which actions show
};
export type MemoryView = { groups: Array<{ category: string; label: string; beliefs: MemoryBelief[] }> } | null;

export type Recommendation = {
  id?: string;
  runId?: string;
  title: string;
  summary: string;
  primaryGoalId?: string | null;
  whyThisAction: string;
  whyNow: string;
  executionSteps: Array<{ title: string; description: string }>;
  confidence: string;
  expectedBenefit: string;
  successSignal: { description: string; timeframe: string; target: string | null } | null;
} | null;

export type Goal = { id: string; horizon: string; title: string; description: string | null };
export type Insight = { id: string; title: string; finding: string; confidence: string };

export type ActionMode = "recommend" | "approve_execute" | "autonomous";

export type SuggestedAction = {
  headline: string;
  keyNumbers?: Array<{ label: string; value: string }>;
  topItems?: Array<{ title: string; detail?: string }>;
  sourceRecommendation?: {
    id: string | null;
    runId: string | null;
    title: string;
    summary: string;
    whyThisAction: string;
    whyNow: string;
    successSignal: { description?: string; timeframe?: string; target?: string | null } | null;
    primaryGoalId?: string | null;
  } | null;
  executable: boolean;
  actionRunId?: string;
  actionType?: string;
  mode?: ActionMode;
  markdownPercent?: number;
  note?: string;
  /**
   * Why Jefe is leaving this one to the merchant, in their words. Null when there is nothing
   * specific to say — the surface then uses its own general line rather than inventing a
   * reason. Read from the stored eligibility record, which had been written and never used.
   */
  raise?: { reason: string; detail: string | null } | null;
};

export type ExecutedActionOutcome =
  | { measured: false }
  | {
      measured: true;
      variantsCleared?: number;
      variantsSold?: number;
      unitsMoved?: number;
      revenueRecovered?: string;
      effectivenessRatePercent?: number;
      summary?: string;
    };
export type ExecutedAction = {
  actionRunId: string;
  actionType: string;
  status: string; // "applied" | "partially_applied" | "reverted" | "rejected"
  headline: string;
  appliedAt: string | null;
  revertedAt: string | null;
  rejectedAt?: string | null;
  declineLearning?: string | null;
  sourceRecommendation?: SuggestedAction["sourceRecommendation"];
  baselineSignal?: string | null;
  currentSignal?: string | null;
  outcome: ExecutedActionOutcome;
};

export type ActionChatThread = {
  topic: string | null;
  messages: Array<{ id: string; role: string; content: string; createdAt?: string }>;
};

// ── Memory mapping ─────────────────────────────────────────────────────────────
// The 13a Memory groups beliefs by AUTHORSHIP, not schema category: what Jefe worked
// out, what the merchant told him, and what he's still guessing. Each entry renders a
// plain-English statement, a source line, and the right action set.

export type MemoryEntry = {
  id: string; // the belief id — posted to the memory.* intents (resolved to its key server-side)
  statement: string; // plain-English (gap #1) — falls back to the belief title
  sourceLine: string | null; // provenance (gap #2)
  authored: boolean; // merchant-authored OR confirm-pending → the 3px navy rule
  confirmState: "settled" | "unsure" | "blocked";
};

// An open question from the merchant-memory questions/gap feed (getOpenQuestions). Drives
// the "Still guessing" group — sourced from the questions feed, NOT belief status — and is
// answered through the memory.answer_question intent (→ sendConversationMessage). No
// fabrication: absent ⇒ the group simply doesn't render.
export type MemoryQuestion = {
  id: string; // open-question id — posted as relatedOpenQuestionId
  question: string; // the plain-English question shown as the statement
  reason: string | null; // why Jefe needs it → the source line
  answerType: string; // "text" | "option"
  answerOptions: string[]; // for "option" questions, the allowed answers
};
export type MemoryGroupKey = "worked_out" | "told" | "guessing";
export type MemoryGroup = { key: MemoryGroupKey; label: string; entries: MemoryEntry[] };

const GROUP_LABEL: Record<MemoryGroupKey, string> = {
  worked_out: "How the store sells",
  told: "What you've told me",
  guessing: "Still guessing",
};

// Defensive: never surface a structured/JSON blob or an over-long value as a "statement".
function cleanValue(value: string | null | undefined): string {
  if (!value) return "";
  const v = value.trim();
  if (v.startsWith("{") || v.startsWith("[")) return "";
  if (v.length > 72) return "";
  return v;
}

// A plain-English statement for a belief. Prefer the pipeline's own rendering; otherwise
// build the most human line today's data honestly supports (title, optionally · value).
export function statementFor(b: MemoryBelief): string {
  if (b.statement && b.statement.trim()) return b.statement.trim();
  const v = cleanValue(b.value);
  return v && v.toLowerCase() !== b.title.toLowerCase() ? `${b.title} · ${v}` : b.title;
}

function authorshipOf(b: MemoryBelief): "merchant" | "jefe" {
  if (b.authorship) return b.authorship;
  if (b.status === "merchant_confirmed" || b.status === "merchant_corrected") return "merchant";
  return "jefe";
}

function confirmStateOf(b: MemoryBelief): "settled" | "unsure" | "blocked" {
  if (b.confirmState) return b.confirmState;
  if (b.status === "needs_input" || b.status === "blocked") return "blocked";
  if (b.status === "merchant_confirmed" || b.status === "merchant_corrected") return "settled";
  // An unconfirmed inference is "unsure" — Jefe would like a yes/no.
  return "unsure";
}

function groupOf(b: MemoryBelief): MemoryGroupKey {
  const confirm = confirmStateOf(b);
  if (confirm === "blocked") return "guessing";
  if (authorshipOf(b) === "merchant") return "told";
  return "worked_out";
}

// A source line. Prefer the pipeline's; otherwise degrade to the evidence summary or an
// honest generic, and label merchant authorship plainly.
function sourceLineFor(b: MemoryBelief): string | null {
  if (b.sourceLine && b.sourceLine.trim()) return b.sourceLine.trim();
  const author = authorshipOf(b);
  if (author === "merchant") return b.status === "merchant_corrected" ? "you corrected this" : "you told me";
  const ev = (b.evidenceSummary || "").trim();
  if (ev && ev.length <= 80 && !ev.startsWith("{")) return ev;
  return "from your Shopify data";
}

export function toMemoryGroups(memory: MemoryView): MemoryGroup[] {
  const beliefs = (memory?.groups || []).flatMap((g) => g.beliefs);
  const buckets: Record<MemoryGroupKey, MemoryEntry[]> = { worked_out: [], told: [], guessing: [] };
  for (const b of beliefs) {
    const confirmState = confirmStateOf(b);
    buckets[groupOf(b)].push({
      id: b.id,
      statement: statementFor(b),
      sourceLine: sourceLineFor(b),
      // The navy rule marks merchant-authored facts AND confirm-pending inferences —
      // both are "the merchant's turn", which is what the rule signals.
      authored: authorshipOf(b) === "merchant" || confirmState === "unsure",
      confirmState,
    });
  }
  return (Object.keys(buckets) as MemoryGroupKey[])
    .map((key) => ({ key, label: GROUP_LABEL[key], entries: buckets[key] }));
}

export function memoryCounts(groups: MemoryGroup[]): { total: number; told: number; unsure: number } {
  let total = 0;
  let told = 0;
  let unsure = 0;
  for (const g of groups) {
    total += g.entries.length;
    if (g.key === "told") told += g.entries.length;
    unsure += g.entries.filter((e) => e.confirmState === "unsure").length;
  }
  return { total, told, unsure };
}
