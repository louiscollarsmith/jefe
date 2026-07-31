import { AppHome13a, type AppHome13aProps } from "./app-home/AppHome13a";
import type { Finding, HorizonItem, HorizonWatch, QueueItem, GoalChange, ActionPolicy, ChannelRow } from "./app-home/sections";
import type { Metrics, MemoryView, Recommendation, Goal, Insight, SuggestedAction, ExecutedAction, ActionMode } from "./app-home/data";

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
// mode + real channel connections (Settings).

const BOOKING_URL = "https://calendly.com/quiver-matt";
const FOUNDER_EMAIL = "matt@mynamejefe.com";
const ACTION_MODES: ActionMode[] = ["recommend", "approve_execute", "autonomous"];

// The real connection shape from listChannelConnections (only the fields we render).
type ChannelConn = { provider: string; connected: boolean; maskedDestination?: string | null; accountName?: string | null };

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
  clearanceMode?: string | null; // getActionMode(price_markdown) — the real standing mode
  channels?: ChannelConn[]; // listChannelConnections — real connect state
}) {
  const suggestedAction = props.suggestedAction ?? null;
  const executedActions = props.executedActions ?? [];

  // findings ← real insights. The prototype's "findings" ARE insight-style patterns
  // ("your refund rate is 9%…"), so this is a faithful, honest mapping — real content,
  // no fabricated action attached.
  const findings: Finding[] = (props.insights || []).slice(0, 4).map((it) => ({
    id: it.id,
    title: it.title,
    body: it.finding,
    kind: "noticed",
    when: null,
    primary: null,
    dismiss: null,
  }));

  // queue ← real decisions + what's done. suggestedAction + recommendation = needs_you;
  // executed actions = did_it. Never a fabricated handled/declined count.
  const queue: QueueItem[] = [];
  if (suggestedAction) queue.push({ id: "suggested", title: suggestedAction.headline, when: "", kind: "Action", state: "needs_you", note: null });
  if (props.recommendation) queue.push({ id: "plan", title: props.recommendation.title, when: "", kind: "Plan", state: "needs_you", note: null });
  for (const a of executedActions) queue.push({ id: a.actionRunId, title: a.headline, when: formatWhen(a.appliedAt), kind: "Done", state: "did_it", note: null });

  // horizon ← the real computed seasonal timeline (dates derived from today, never
  // hardcoded). "Watching" stays empty until store-grounded near-term signals are wired.
  const horizonNear: HorizonItem[] = buildHorizon(new Date()).map((e) => ({ id: e.key, date: e.dateLabel, title: e.title, body: e.note, action: null }));
  const horizonWatching: HorizonWatch[] = [];

  // Settings autonomy — the full 13a action roster (design_handoff / sample.ts: Tidy-ups /
  // Listing copy / Pricing / Reordering, that order + labels + detail). Per wire-or-keep
  // (AGENTS.md → Design fidelity), every action type in the design is rendered. "Live" is
  // grounded in the action engine (chat 9/10): only action types registered + resolvable
  // (ACTION_REGISTRY / RESOLVERS) get a real dial — today just `price_markdown` (dead-stock
  // clearance, surfaced as "Pricing"), wired to getActionMode/setActionMode. `tidy_up` and
  // `listing_copy` have no primitive yet → gated "Soon". `reordering` keeps its real
  // needs-you prompt (blockedReason), not a "Soon", per the design. `product_status_change`
  // has a built-but-dark adapter but isn't registered, so it's intentionally not a dial here.
  // When a type graduates into the registry, add its getActionMode read in the loader and set
  // its row's `mode` (dropping `soon`). No fabricated dials; no fabricated numbers — the
  // margin-floor detail stays generic (the design mock's "30%" is Everdew sample data).
  const policies: ActionPolicy[] = [
    { actionType: "tidy_up", label: "Tidy-ups", detail: "Missing types, broken links, unclaimed refunds", mode: null, soon: true },
    { actionType: "listing_copy", label: "Listing copy", detail: "Descriptions, titles, product types", mode: null, soon: true },
    { actionType: "price_markdown", label: "Pricing", detail: "Never below your margin floor", mode: normalizeMode(props.clearanceMode) },
    { actionType: "reordering", label: "Reordering", detail: "Blocked until Jefe knows your supplier lead times", mode: null, blockedReason: "Tell me who supplies you" },
  ];

  const channels: ChannelRow[] = (props.channels || []).map((c) => ({
    id: c.provider,
    label: channelLabel(c.provider),
    value: c.connected ? (c.maskedDestination || c.accountName || "Connected") : "Not connected",
    connected: c.connected,
  }));

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
    changelog: [], // "New in Jefe" reads the app CHANGELOG — wired as a follow-up
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

// Seasonal timeline. Dates are computed from `now`, never hardcoded — a wrong seasonal
// date destroys the credibility this surface exists to build. (Carried over verbatim
// from the 5a build; it's real, deterministic logic.)
type HorizonEntry = { key: string; title: string; date: Date; note: string; dateLabel: string };

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + shift + (n - 1) * 7);
}
function blackFridayFor(year: number): Date {
  const thanksgiving = nthWeekdayOfMonth(year, 10, 4, 4); // 4th Thursday of November
  return new Date(year, 10, thanksgiving.getDate() + 1);
}
function rollForward(now: Date, build: (year: number) => Date): Date {
  const y = now.getFullYear();
  const candidate = build(y);
  return candidate.getTime() < now.getTime() ? build(y + 1) : candidate;
}
function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function buildHorizon(now: Date): HorizonEntry[] {
  const raw: Array<{ key: string; title: string; date: Date; note: string }> = [
    { key: "back-to-school", title: "Back-to-school demand", date: rollForward(now, (y) => new Date(y, 8, 1)), note: "Routine-building season for skincare. Stock and bundle decisions want to be set about a month out." },
    { key: "bfcm", title: "Black Friday / Cyber weekend", date: rollForward(now, blackFridayFor), note: "Your biggest weekend. Supplier lead times run roughly nine weeks, so the real decisions land in early autumn — not the week before." },
    { key: "christmas", title: "Christmas last-order cut-off", date: rollForward(now, (y) => new Date(y, 11, 20)), note: "The last date customers can order and still get it in time. Carrier cut-offs and stock buffers need setting well ahead." },
    { key: "returns", title: "January returns wave", date: rollForward(now, (y) => new Date(y, 0, 6)), note: "The post-holiday returns spike. Worth deciding your returns and win-back approach before it arrives." },
  ];
  return raw
    .map((e) => ({ key: e.key, title: e.title, date: e.date, note: e.note, dateLabel: dayLabel(e.date) }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
