import { useEffect } from "react";
import { useFetcher } from "react-router";
import { AppHome13a, type AppHome13aProps } from "./app-home/AppHome13a";
import type { Finding, HorizonItem, HorizonWatch, QueueItem, GoalChange, ActionPolicy, ChannelRow } from "./app-home/sections";
import type { Metrics, MemoryView, Recommendation, Goal, Insight, SuggestedAction, ExecutedAction, ActionMode, MemoryQuestion } from "./app-home/data";

// Re-exported for back-compat: action-resolution.server.js references this type via a
// JSDoc `import("../../components/daily-home").SuggestedAction`.
export type { SuggestedAction } from "./app-home/data";

// The live, data-driven Jefe app home in the "13a" register (design_handoff_jefe_app).
// This component IS the live adoption of the redesign: it maps the app._index loader's
// REAL merchant data into <AppHome13a>, with honest fallbacks where the richer 13a data
// isn't wired yet (per-goal behaviour changes, a store-grounded horizon, a tidy-up scan)
// so no section fabricates a number. The clearance suggested-action card + "What Jefe
// did" feed live inside AppHome13a's sections and post the same action.* intents this
// route already handles. Supersedes the earlier hand-rolled "5a" build.
//
// Real data in play: metrics · memory (with chat 9's authorship/provenance/confirm-state;
// plain-English `statement` falls back to the belief title until chat 9's pass lands) ·
// the Plan recommendation · the executable clearance suggestion · the executed-action
// feed · goals · insights (surfaced as Brief findings) · the live per-action autonomy
// mode + real channel connections (Settings) · the open-questions feed (Memory's "Still
// guessing"). This is the live home, so it passes `interactive` — the Memory controls
// (confirm / correct / forget / teach / answer) post real memory.* intents to app._index.

const BOOKING_URL = "https://calendly.com/quiver-matt";
const FOUNDER_EMAIL = "matt@mynamejefe.com";
const ACTION_MODES: ActionMode[] = ["recommend", "approve_execute", "autonomous"];

// The 13a Settings action roster — DESIGN copy only (labels / detail / order / soon-vs-blocked
// prompt), keyed by actionType (design_handoff / sample.ts). Which rows are LIVE is engine truth,
// derived at render from the loader's `actionModes` map (built off listActionTypes()), NOT hardcoded
// here — so a newly-graduated action lights its dial with zero edit. `reordering` carries a real
// needs-you `blockedReason` (an actionable ask, not a "Soon"). No fabricated numbers: the Pricing
// detail states the real guardrail (clearance floors at unit cost), not a margin % (chat 11).
const ACTION_ROSTER: Array<{ actionType: string; label: string; detail: string; blockedReason?: string }> = [
  { actionType: "tidy_up", label: "Tidy-ups", detail: "Missing types, broken links, unclaimed refunds" },
  { actionType: "listing_copy", label: "Listing copy", detail: "Descriptions, titles, product types" },
  { actionType: "price_markdown", label: "Pricing", detail: "Never below what it cost you" },
  { actionType: "reordering", label: "Reordering", detail: "Blocked until Jefe knows your supplier lead times", blockedReason: "Tell me who supplies you" },
];

// The real connection shape from listChannelConnections (only the fields we render).
type ChannelConn = { provider: string; connected: boolean; maskedDestination?: string | null; accountName?: string | null };

// Loader-provided shapes for the 13a home extras — all real data.
type ChatThread = { messages: Array<{ id: string; role: string; content: string }> };
type ChangelogItem = { id: string; date: string; text: string; tag?: string | null; body?: string | null };
type EmailBrief = {
  address: string;
  enabled: boolean;
  sendTime: string | null;
  hour: number | null;
  minute: number | null;
  frequency: string;
  sending: boolean;
};

export function DailyHome(props: {
  storeName: string;
  merchantName?: string;
  metrics: Metrics;
  memory: MemoryView;
  recommendation: Recommendation;
  suggestedAction?: SuggestedAction | null;
  executedActions?: ExecutedAction[];
  insights: Insight[];
  goals: Goal[];
  actionModes?: Record<string, string>; // actionType → mode, LIVE types only (key present ⇒ live)
  channels?: ChannelConn[]; // listChannelConnections — real connect state
  conversation?: ChatThread | null; // getDailyChatThread — real in-app chat thread
  changelog?: ChangelogItem[]; // loadAppHomeWhatsNew — curated merchant-facing product news
  emailBrief?: EmailBrief | null; // morning_brief pref + real contact email; null → row hidden
  openQuestions?: MemoryQuestion[]; // getOpenQuestions — Memory's "Still guessing" feed
  horizonNear: HorizonItem[]; // store-grounded near-term items + seasonal timeline (loader-computed)
  horizonWatching: HorizonWatch[]; // "Watching, not acting" — honest revisit dates (loader-computed)
}) {
  const suggestedAction = props.suggestedAction ?? null;
  const executedActions = props.executedActions ?? [];

  // The store-hygiene scan is DEFERRED off the LCP-critical loader (chat 10's split): DailyHome
  // pulls it from the /api/store-hygiene resource route via useFetcher AFTER first paint, so the
  // Brief's metrics render immediately and the tidy-up findings stream in a beat later. Best-effort
  // (the route returns [] on any failure), so this can never delay or break the home.
  const findingsFetcher = useFetcher<{ findings: Finding[] }>();
  useEffect(() => {
    if (findingsFetcher.state === "idle" && findingsFetcher.data === undefined) {
      findingsFetcher.load("/api/store-hygiene");
    }
  }, [findingsFetcher]);

  // findings ← the real store-hygiene scan FIRST (tidy-ups with a real primary action that
  // deep-links to the fix in Shopify admin — never auto-applied), then real insight patterns
  // ("your refund rate is 9%…") as actionless "noticed" notes fill any remaining room (coexist,
  // don't supersede — chat 11). Both are real; hygiene leads because the merchant can act on it.
  // Capped at 4 total so "Your call" stays calm (chat 11).
  const hygieneFindings = findingsFetcher.data?.findings ?? [];
  const insightFindings: Finding[] = (props.insights || []).map((it) => ({
    id: it.id,
    title: it.title,
    body: it.finding,
    kind: "noticed",
    when: null,
    primary: null,
    dismiss: null,
  }));
  const findings: Finding[] = [...hygieneFindings, ...insightFindings].slice(0, 4);

  // queue ← real decisions + what's done. suggestedAction + recommendation = needs_you;
  // executed actions = did_it. Never a fabricated handled/declined count.
  const queue: QueueItem[] = [];
  if (suggestedAction) queue.push({ id: "suggested", title: suggestedAction.headline, when: "", kind: "Action", state: "needs_you", note: null });
  if (props.recommendation) queue.push({ id: "plan", title: props.recommendation.title, when: "", kind: "Plan", state: "needs_you", note: null });
  for (const a of executedActions) queue.push({ id: a.actionRunId, title: a.headline, when: formatWhen(a.appliedAt), kind: "Done", state: "did_it", note: null });

  // horizon ← store-grounded near-term items + a "watching" block, computed server-side
  // by getStoreGroundedHorizon (stock run-out dates, refund projection) with the seasonal
  // timeline merged in. Passed straight through; this component never fabricates a number.
  const horizonNear = props.horizonNear;
  const horizonWatching = props.horizonWatching;

  // Settings autonomy — the full 13a roster (ACTION_ROSTER holds the design copy). Which rows are
  // LIVE is derived from the loader's `actionModes` map (built off the engine's listActionTypes(),
  // chat 10): a key present ⇒ that type is registered + its execute-flag is on ⇒ a real dial at the
  // merchant's mode. A design row with no live mode renders its needs-you prompt (reordering's
  // blockedReason) or a gated "Soon" (tidy_up / listing_copy) — never a dial that can't act. When an
  // action graduates (registry entry + flag on, e.g. product_status_change), its row auto-lights with
  // zero edit here. No fabricated dials; no fabricated numbers.
  const actionModes = props.actionModes ?? {};
  const policies: ActionPolicy[] = ACTION_ROSTER.map((row) => {
    const liveMode = actionModes[row.actionType]; // present iff the type is live
    if (liveMode != null)
      return { actionType: row.actionType, label: row.label, detail: row.detail, mode: normalizeMode(liveMode) };
    if (row.blockedReason)
      return { actionType: row.actionType, label: row.label, detail: row.detail, mode: null, blockedReason: row.blockedReason };
    return { actionType: row.actionType, label: row.label, detail: row.detail, mode: null, soon: true };
  });

  // The email-brief row (real address + real send time) leads "Where Jefe reaches
  // you", ahead of the connected channels. Built ONLY when a real contact email is
  // known — never fabricated. While scheduled delivery is dark, the note says so
  // honestly rather than implying Jefe emails today.
  const emailBrief = props.emailBrief ?? null;
  const emailRow: ChannelRow | null = emailBrief
    ? {
        id: "email",
        label: "Morning brief by email",
        value:
          emailBrief.enabled && emailBrief.sendTime
            ? `${emailBrief.address} · ${emailBrief.sendTime}`
            : emailBrief.address,
        connected: true,
        editable: true,
        category: "morning_brief",
        enabled: emailBrief.enabled,
        frequency: emailBrief.frequency,
        time24:
          emailBrief.hour != null && emailBrief.minute != null
            ? `${String(emailBrief.hour).padStart(2, "0")}:${String(emailBrief.minute).padStart(2, "0")}`
            : null,
        note: !emailBrief.enabled
          ? "Paused — you won’t get the morning brief"
          : emailBrief.sending
            ? null
            : "Not sending yet — starts when briefs go live",
      }
    : null;
  const channels: ChannelRow[] = [
    ...(emailRow ? [emailRow] : []),
    ...(props.channels || []).map((c) => ({
      id: c.provider,
      label: channelLabel(c.provider),
      value: c.connected ? (c.maskedDestination || c.accountName || "Connected") : "Not connected",
      connected: c.connected,
    })),
  ];

  const waiting = (suggestedAction ? 1 : 0) + (props.recommendation ? 1 : 0) + findings.length;

  const appProps: AppHome13aProps = {
    storeName: props.storeName,
    briefHeadline: waiting > 0 ? "Here’s what’s worth your time." : "Nothing’s on fire — you’re all clear.",
    metrics: props.metrics,
    memory: props.memory,
    recommendation: props.recommendation,
    suggestedAction,
    executedActions,
    goals: props.goals,
    findings,
    goalChanges: [] as GoalChange[], // no per-goal behaviour tracking yet → honest note
    horizonNear,
    horizonWatching,
    queue,
    policies,
    channels,
    autonomyLabel: "Learning",
    syncedLabel: null, // no real "synced Xm ago" signal yet → omitted, not faked
    founderEmail: FOUNDER_EMAIL,
    bookingUrl: BOOKING_URL,
    changelog: props.changelog ?? [], // "New in Jefe" ← real app CHANGELOG
    conversation: props.conversation ?? { messages: [] }, // real in-app chat thread
    // This IS the live merchant home → the Memory controls post real memory.* intents,
    // and the "Still guessing" group reads the real open-questions feed.
    interactive: true,
    openQuestions: props.openQuestions ?? [],
  };

  return <AppHome13a {...appProps} />;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function normalizeMode(mode: string | null | undefined): ActionMode {
  return mode && (ACTION_MODES as string[]).includes(mode) ? (mode as ActionMode) : "approve_execute";
}
function channelLabel(provider: string): string {
  if (provider === "slack") return "Slack";
  if (provider === "whatsapp") return "WhatsApp";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}
function formatWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
