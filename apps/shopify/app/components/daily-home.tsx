import { Form, Link, useActionData, useLocation, useNavigation } from "react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { HorizonItem, HorizonWatch } from "./app-home/sections";
import { formatDateInZone } from "../lib/home/home-dates.js";
import type {
  ActionChatThread,
  ExecutedAction,
  Goal,
  Insight,
  MemoryQuestion,
  MemoryView,
  Metrics,
  Recommendation,
  SuggestedAction,
} from "./app-home/data";

// Re-exported for back-compat: action-resolution.server.js references this type via a
// JSDoc `import("../../components/daily-home").SuggestedAction`.
export type { SuggestedAction } from "./app-home/data";

const COLORS = {
  page: "#fbfaf7",
  card: "#fffdfa",
  border: "#d8d0c8",
  hairline: "#ede7de",
  ink: "#1f2933",
  body: "#4d463f",
  muted: "#6d7175",
  meta: "#8a8177",
  navy: "#1f3a63",
  yellow: "#ffe85c",
  greenWash: "#eef8f0",
  greenBorder: "#7fc08d",
  green: "#26723d",
};

const FONT = {
  sans: "'Schibsted Grotesk', system-ui, -apple-system, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
};

type ChatThread = { messages: Array<{ id: string; role: string; content: string }> };
// A proactive heads-up Jefe posts into the thread from a standing condition (a run-out
// approaching, refunds trending). Re-rendered from current state each load — not stored —
// so it stays honest and can't go stale. Shown as a feed (uncapped in the render); the
// cadence ceiling that keeps it from becoming noise lives on the outbound-send path.
type HeadsUp = { id: string; kind: string; text: string };
type ChannelConn = { provider: string; connected: boolean; maskedDestination?: string | null; accountName?: string | null };
type EmailBrief = {
  address: string;
  enabled: boolean;
  sendTime: string | null;
  hour: number | null;
  minute: number | null;
  frequency: string;
  sending: boolean;
};

type PrimaryMove = {
  title: string;
  summary: string;
  whyThisAction: string;
  whyNow: string;
  successSignal: string | null;
  recommendationId: string | null;
  recommendationRunId: string | null;
  actionRunId: string | null;
  actionType: string | null;
  executable: boolean;
  state: "proposed" | "in_progress" | "empty";
  statusLabel: string;
  statusTone: "yellow" | "green";
  approvedAt: string | null;
  baselineSignal: string | null;
  currentSignal: string | null;
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
  actionModes?: Record<string, string>;
  channels?: ChannelConn[];
  conversation?: ChatThread | null;
  actionChatId?: string | null;
  actionChatThread?: ActionChatThread | null;
  changelog?: Array<{ id: string; date: string; text: string; tag?: string | null; body?: string | null }>;
  emailBrief?: EmailBrief | null;
  openQuestions?: MemoryQuestion[];
  horizonNear: HorizonItem[];
  horizonWatching: HorizonWatch[];
  todayLabel?: string; // loader-computed, store-tz-pinned; replaces render-time new Date()
  storeTimeZone?: string | null; // the store's IANA zone; pins fixed-instant date labels
  horizonHeadsUps?: HeadsUp[]; // proactive run-out / refund heads-ups, rendered as messages
  brandLogoUrl?: string | null; // merchant's brand logo for the header; monogram fallback
}) {
  const location = useLocation();
  const suggestedAction = props.suggestedAction ?? null;
  const actions = props.executedActions ?? [];
  const primaryMove = buildPrimaryMove({
    recommendation: props.recommendation,
    suggestedAction,
    actions,
    goals: props.goals,
    storeTimeZone: props.storeTimeZone,
  });
  const chatOpen = Boolean(props.actionChatId);

  if (chatOpen) {
    return (
      <ActionChat
        move={primaryMove}
        thread={props.actionChatThread ?? { topic: null, messages: [] }}
        backTo={searchWith(location.search, { actionChat: null })}
        todayLabel={props.todayLabel}
      />
    );
  }

  // Shape B: the home IS the store-level conversation. The next move, and Jefe's
  // reports back on moves already made, arrive as messages in that one thread — not
  // as a dashboard of cards. Everything else (Watching, Goals, autonomy, changelog)
  // has moved off the home to its own surface; nothing gets added back here.
  const outcomes = actions.filter(
    (action) => action.actionRunId !== primaryMove.actionRunId,
  );
  // The frame for every recommendation: one quiet line, not a section (the reviewer's
  // single keep-from-the-strip). Null when Jefe has no goal yet — never fabricated.
  const goalLine = firstGoalLine(props.goals);
  // The conversation index (left rail): wayfinding once the thread accumulates moments.
  // Absent on a fresh store, so the home stays a single centered column until there's
  // something to index. Hidden on narrow viewports (see HOME_INDEX_RESPONSIVE_CSS).
  const indexEntries = buildConversationIndex(outcomes, primaryMove, props.storeTimeZone);
  const hasIndex = indexEntries.length > 0;

  return (
    <main style={pageStyle}>
      <style>{HOME_INDEX_RESPONSIVE_CSS}</style>
      <div style={hasIndex ? shellWideStyle : shellStyle}>
        <Header
          storeName={props.storeName}
          todayLabel={props.todayLabel}
          goalLine={goalLine}
          brandLogoUrl={props.brandLogoUrl}
          currentSearch={location.search}
        />
        <div style={homeGridStyle} className="jefe-home-grid">
          {hasIndex ? <ConversationIndex entries={indexEntries} /> : null}
          <div style={homeMainColStyle}>
            <StoreConversation
              conversation={props.conversation ?? null}
              move={primaryMove}
              outcomes={outcomes}
              headsUps={props.horizonHeadsUps ?? []}
              quietLine={buildQuietLine(props.horizonWatching, props.insights)}
              currentSearch={location.search}
            />
          </div>
        </div>
      </div>
    </main>
  );
}

// The store-level conversation — Shape B's home. One thread: the real back-and-forth
// (getDailyChatThread), Jefe reporting back on moves already made (outcomes as
// messages), and the current move as the freshest message with a zoom into its own
// action chat. The composer posts `chat.message` (the store thread); the per-move
// zoom (ActionChat) posts `action.chat.message`. View decides the intent — no thread
// picker. On a genuinely quiet day the thread is a single grounded line, never empty
// and never fabricated.
function StoreConversation({
  conversation,
  move,
  outcomes,
  headsUps,
  quietLine,
  currentSearch,
}: {
  conversation: ChatThread | null;
  move: PrimaryMove;
  outcomes: ExecutedAction[];
  headsUps: HeadsUp[];
  quietLine: string;
  currentSearch: string;
}) {
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const isSending =
    navigation.state !== "idle" && pendingIntent === "chat.message";
  // A retry is Jefe having another go at a message already in the thread, so it shows the
  // same "Thinking" line — but it must NOT re-render the merchant's text as pending, or
  // their message would appear twice while it runs.
  const isRetrying =
    navigation.state !== "idle" && pendingIntent === "chat.retry";
  const isThinking = isSending || isRetrying;
  const pendingMessage =
    isSending && typeof navigation.formData?.get("message") === "string"
      ? String(navigation.formData.get("message")).trim()
      : "";
  const [composerMessage, setComposerMessage] = useState("");
  const actionData = useActionData() as
    | { ok?: boolean; error?: string; kind?: string | null; intent?: string }
    | undefined;

  const history = conversation?.messages ?? [];
  // A reply that never arrived, detected from the THREAD rather than from the failed
  // request. The merchant's message commits before Jefe is asked, so a thread whose last
  // message is theirs means Jefe owes them an answer — and that stays true after a reload,
  // after the route error boundary's "Try again", and in a tab opened later. Keying this
  // off the action result alone would lose the retry the moment the page reloaded, which
  // is precisely the "nothing to retry" gap.
  const lastMessage = history[history.length - 1];
  const awaitingReply =
    !isThinking &&
    !pendingMessage &&
    (lastMessage?.role === "merchant" || lastMessage?.role === "user");
  const hasMove = move.state !== "empty";
  // Proactive heads-ups (run-outs, refunds) render as a feed here — NOT capped: the
  // merchant wants to see whatever's genuinely real (Matt's call). The ~5/day *cadence*
  // ceiling is a different mechanism that lives on the outbound/proactive-send path
  // (notifications/Slack), not this live render, and is a ceiling-not-target — Jefe says
  // less when less is real, never filler. Dedup is inherent: they're re-derived from
  // state each load, never stored.
  // The grounded fallback line shows ONLY when there is genuinely nothing real to say —
  // no move, no reports, no history, no heads-up. Silence-with-a-real-line, never filler.
  const showQuietLine =
    !hasMove &&
    outcomes.length === 0 &&
    history.length === 0 &&
    headsUps.length === 0;
  const bottomRef = useStickToBottom(
    history.length +
      outcomes.length +
      headsUps.length +
      (hasMove ? 1 : 0) +
      (showQuietLine ? 1 : 0) +
      (pendingMessage ? 1 : 0) +
      (isThinking ? 1 : 0) +
      (awaitingReply ? 1 : 0),
  );

  return (
    <section style={conversationStyle}>
      <div style={messagesStyle}>
        {history.map((message) => (
          <MessageRow key={message.id} from={message.role}>
            {message.content}
          </MessageRow>
        ))}
        {outcomes.map((action) => (
          <MessageRow
            key={action.actionRunId}
            anchorId={`moment-${action.actionRunId}`}
            from="assistant"
          >
            {outcomeMessageText(action)}
          </MessageRow>
        ))}
        {headsUps.map((headsUp) => (
          <MessageRow key={headsUp.id} from="assistant">
            {headsUp.text}
          </MessageRow>
        ))}
        {hasMove ? <MoveMessage move={move} currentSearch={currentSearch} /> : null}
        {showQuietLine ? <MessageRow from="assistant">{quietLine}</MessageRow> : null}
        {pendingMessage ? <MessageRow from="merchant">{pendingMessage}</MessageRow> : null}
        {isThinking ? (
          <div style={messageRowStyle} aria-live="polite">
            <span style={smallMarkStyle}>J</span>
            <div style={thinkingStyle}>Thinking</div>
          </div>
        ) : null}
        {awaitingReply ? (
          <ReplyFailedRow message={actionData?.error} />
        ) : null}
        <div ref={bottomRef} aria-hidden="true" />
      </div>
      <div style={chatComposerWrapStyle}>
        <div style={chipsStyle}>
          <StorePrompt message="What changed this week?" />
          <StorePrompt message="Anything I should worry about?" />
          <StorePrompt message="How are my goals looking?" />
        </div>
        <ChatComposer
          intent="chat.message"
          placeholder="Ask Jefe anything, or tell me what changed…"
          ariaLabel="Message Jefe"
          value={composerMessage}
          onChange={setComposerMessage}
          disabled={isThinking}
        />
      </div>
    </section>
  );
}

// Jefe failing to answer, said in the thread rather than on an error page. This renders in
// Jefe's own message position on purpose: a reply that didn't arrive is Jefe's problem, not
// a fault in what the merchant typed, and it reads as part of the conversation. The retry
// posts `chat.retry`, which answers the message already sitting above it — the merchant
// never retypes, and the thread never ends up holding what they said twice.
function ReplyFailedRow({ message }: { message?: string }) {
  const navigation = useNavigation();
  const isRetrying =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "chat.retry";
  return (
    <div style={messageRowStyle} aria-live="polite">
      <span style={smallMarkStyle}>J</span>
      <div style={replyFailedBubbleStyle}>
        <span>{message || "I couldn't get to that one just now — your message is saved."}</span>
        <Form method="post">
          <input type="hidden" name="intent" value="chat.retry" />
          <button type="submit" style={replyRetryButtonStyle} disabled={isRetrying}>
            {isRetrying ? "Trying again…" : "Try again"}
          </button>
        </Form>
      </div>
    </div>
  );
}

function MessageRow({
  from,
  children,
  anchorId,
}: {
  from: string;
  children: ReactNode;
  anchorId?: string;
}) {
  const isMerchant = from === "merchant" || from === "user";
  return (
    <div
      id={anchorId}
      style={{ ...messageRowStyle, justifyContent: isMerchant ? "flex-end" : "flex-start" }}
    >
      {!isMerchant ? <span style={smallMarkStyle}>J</span> : null}
      <div style={isMerchant ? merchantBubbleStyle : assistantBubbleStyle}>{children}</div>
    </div>
  );
}

// The move as a message in the thread: enough to recognise it, with a zoom into its
// own action chat ("Talk this through →" sets ?actionChat=<id>) where the merchant
// approves, declines or revises it. The decision never happens on the home feed.
function MoveMessage({ move, currentSearch }: { move: PrimaryMove; currentSearch: string }) {
  const chatTarget = move.recommendationId ?? move.actionRunId ?? "move";
  const subtitle = informativeSubtitle(move.summary, move.title);
  return (
    <div
      id={`moment-${chatTarget}`}
      style={{ ...messageRowStyle, justifyContent: "flex-start" }}
    >
      <span style={smallMarkStyle}>J</span>
      <div style={moveMessageStyle}>
        <div style={cardTopStyle}>
          <Mono>{move.state === "in_progress" ? "IN PROGRESS" : "YOUR NEXT MOVE"}</Mono>
          <StatusPill tone={move.statusTone}>{move.statusLabel}</StatusPill>
        </div>
        <strong style={moveMessageTitleStyle}>{move.title}</strong>
        {subtitle ? <p style={moveMessageSummaryStyle}>{subtitle}</p> : null}
        {/* Approve / decline / revise live in the move's own chat (the zoom level), never on
            the home feed — an executable commitment happens in the focused surface. */}
        <div style={moveMessageActionsStyle}>
          <Link to={searchWith(currentSearch, { actionChat: chatTarget })} style={primaryButtonStyle}>
            Talk this through →
          </Link>
        </div>
      </div>
    </div>
  );
}

// The conversation index — wayfinding INSIDE the one thread (never a thread picker).
// Only MOMENTS earn a place: an action executed / reported-back / declined / reverted, and
// the current proposed move. Each carries the DOM id of its message so the rail can scroll
// to it. Goals and free-text corrections are deliberately NOT here yet — they need change-
// events / message tagging the layer doesn't emit, and a fabricated timestamp is worse than
// an omission (AGENTS.md:58). The executed half is real ledger data. Pure — no message-text
// scraping.
type IndexEntry = { id: string; label: string; kind: string; dateLabel: string };

function buildConversationIndex(
  outcomes: ExecutedAction[],
  move: PrimaryMove,
  storeTimeZone?: string | null,
): IndexEntry[] {
  const entries: IndexEntry[] = outcomes.map((action) => {
    let kind: string;
    let when: string | null;
    if (action.status === "rejected") {
      kind = "Declined";
      when = action.rejectedAt ?? null;
    } else if (action.status === "reverted") {
      kind = "Reverted";
      when = action.revertedAt ?? null;
    } else if (action.outcome.measured) {
      kind = "Reported back";
      when = action.appliedAt ?? null;
    } else {
      kind = "Done";
      when = action.appliedAt ?? null;
    }
    return {
      id: `moment-${action.actionRunId}`,
      label: action.sourceRecommendation?.title || action.headline,
      kind,
      dateLabel: formatShortDate(when, storeTimeZone),
    };
  });
  if (move.state !== "empty") {
    entries.push({
      id: `moment-${move.recommendationId ?? move.actionRunId ?? "move"}`,
      label: move.title,
      kind: move.state === "in_progress" ? "In progress" : "Move proposed",
      dateLabel: "",
    });
  }
  return entries;
}

// Scroll the thread to a moment's message. Wayfinding, not navigation — it moves you
// within the conversation you're already in; it never swaps threads or changes the URL.
function scrollToMoment(id: string) {
  const el = typeof document === "undefined" ? null : document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function ConversationIndex({ entries }: { entries: IndexEntry[] }) {
  return (
    <nav className="jefe-home-index" aria-label="Conversation index" style={indexRailStyle}>
      <span style={indexHeadingStyle}>In this conversation</span>
      <div style={indexListStyle}>
        {entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            style={indexEntryStyle}
            onClick={() => scrollToMoment(entry.id)}
          >
            <span style={indexEntryLabelStyle}>{entry.label}</span>
            <span style={indexEntryMetaStyle}>
              {entry.dateLabel ? `${entry.kind} · ${entry.dateLabel}` : entry.kind}
            </span>
          </button>
        ))}
      </div>
    </nav>
  );
}

// Jefe reporting back on a move already made — honest copy from the same fields the
// old Action history / Also-in-progress cards used, now rendered as a thread message.
function outcomeMessageText(action: ExecutedAction): string {
  const name = action.sourceRecommendation?.title || action.headline;
  if (action.status === "rejected") {
    return action.declineLearning ?? `You passed on “${name}” — I've noted it wasn't right for now.`;
  }
  if (action.status === "reverted") {
    return `I reverted “${name}”.`;
  }
  if (action.outcome.measured) {
    return action.outcome.summary ?? `“${name}” is done.`;
  }
  return `“${name}” is applied — I'm tracking how it lands and will report back here.`;
}

// The quiet-day line: grounded in a real thing Jefe is watching (or last noticed),
// never fabricated. Falls back to an honest generic when there's nothing to surface.
function buildQuietLine(horizonWatching: HorizonWatch[], insights: Insight[]): string {
  const watch = (horizonWatching || []).find((item) => item.title);
  if (watch) {
    return watch.reason
      ? `Nothing needs a decision from you right now. I'm keeping an eye on ${watch.title} — ${watch.reason}`
      : `Nothing needs a decision from you right now. I'm keeping an eye on ${watch.title}.`;
  }
  const insight = (insights || []).find((item) => item.title);
  if (insight) {
    return `Nothing needs a decision from you right now. The most recent thing I noticed: ${insight.title}.`;
  }
  return "Nothing needs a decision from you right now — I'll surface your next move here the moment I have one.";
}

// One quiet header line naming the goal Jefe is working towards — the frame for every
// recommendation. Null (renders nothing) when there's no goal yet; never fabricated.
function firstGoalLine(goals: Goal[] | undefined): string | null {
  const goal = (goals || []).find((item) => item.title && item.title.trim());
  return goal ? goal.title.trim() : null;
}

export function DailyHomeLoading({ storeName }: { storeName: string }) {
  return (
    <main style={pageStyle}>
      <div style={shellStyle}>
        <Header storeName={storeName} />
        <h1 style={headlineStyle}>
          Here&apos;s what I&apos;d do <em style={headlineEmStyle}>next.</em>
        </h1>
        <section style={cardStyle} aria-label="Opening Jefe">
          <Mono>OPENING JEFE</Mono>
          <div style={{ height: 28 }} />
          <div style={{ height: 24, maxWidth: 420, background: COLORS.hairline, borderRadius: 8 }} />
          <div style={{ height: 16, maxWidth: 580, background: COLORS.hairline, borderRadius: 8, marginTop: 22 }} />
          <div style={{ height: 16, maxWidth: 500, background: COLORS.hairline, borderRadius: 8, marginTop: 10 }} />
        </section>
      </div>
    </main>
  );
}

function Header({
  storeName,
  todayLabel,
  goalLine,
  brandLogoUrl,
  currentSearch,
}: {
  storeName: string;
  todayLabel?: string;
  goalLine?: string | null;
  brandLogoUrl?: string | null;
  currentSearch?: string;
}) {
  return (
    <header style={headerStyle}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StoreMark storeName={storeName} logoUrl={brandLogoUrl} />
          <strong style={{ fontSize: 16 }}>{storeName || "Jefe Store"}</strong>
        </div>
        {goalLine ? <span style={goalLineStyle}>Working towards {goalLine}</span> : null}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <DateLabel>{todayLabel ?? ""}</DateLabel>
        {/* The home's only door out. The Memory-view footer link was removed from the home
            deliberately (Matt) — but it was the sole navigation off this surface, so Settings
            and Merchant Memory both became unreachable while the route kept serving them.
            The gear is the re-homing that removal assumed: a quiet control, not a section.
            Rendered only when we have the current search: embedded Shopify needs `host` to
            survive the hop, and a gear that drops it is worse than no gear. The loading
            header has no search and so has no gear — there is nothing to navigate to yet. */}
        {currentSearch ? (
          <Link to={settingsHref(currentSearch)} style={gearLinkStyle} aria-label="Settings">
            <GearIcon />
          </Link>
        ) : null}
      </div>
    </header>
  );
}

// Settings, keeping the embedded params Shopify needs (host, shop, embedded) and dropping
// only the ones that describe where you are on the home.
function settingsHref(search: string) {
  const params = new URLSearchParams(search);
  for (const key of ["view", "actionChat", "panel"]) params.delete(key);
  const next = params.toString();
  return `/app/settings${next ? `?${next}` : ""}`;
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

// The header mark wears the MERCHANT's brand: the real brand logo when the store has one
// (from shop.brand, cached in rawPayload), otherwise the store's initial in the navy
// square — an honest monogram, never a fake photo (mirrors the ImageSlot rule).
function StoreMark({ storeName, logoUrl }: { storeName: string; logoUrl?: string | null }) {
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt={storeName ? `${storeName} logo` : "Store logo"}
        width={32}
        height={32}
        style={logoMarkStyle}
      />
    );
  }
  const initial = (storeName || "").trim().charAt(0).toUpperCase() || "J";
  return (
    <span style={markStyle} aria-hidden="true">
      {initial}
    </span>
  );
}

function ActionChat({
  move,
  thread,
  backTo,
  todayLabel,
}: {
  move: PrimaryMove;
  thread: ActionChatThread;
  backTo: string;
  todayLabel?: string;
}) {
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const isThinking =
    navigation.state !== "idle" && pendingIntent === "action.chat.message";
  const pendingMessage =
    isThinking && typeof navigation.formData?.get("message") === "string"
      ? String(navigation.formData.get("message")).trim()
      : "";
  const [composerMessage, setComposerMessage] = useState("");
  const messages = thread.messages.length
    ? thread.messages
    : [
        {
          id: "opening",
          role: "assistant",
          content:
            "Ask me anything about this one. I can explain how I got here, change what it does, or hold it until you are ready.",
        },
      ];
  const subtitle = informativeSubtitle(move.summary, move.title);
  const bottomRef = useStickToBottom(
    messages.length + (pendingMessage ? 1 : 0) + (isThinking ? 1 : 0),
  );
  return (
    <main style={pageStyle}>
      <div style={chatShellStyle}>
        <div style={chatTopStyle}>
          <Link to={backTo} style={backLinkStyle}>
            ← Back
          </Link>
          <DateLabel>{todayLabel ?? ""}</DateLabel>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20 }}>
          <Mono>ABOUT THIS MOVE</Mono>
          <StatusPill tone={move.statusTone}>{move.statusLabel}</StatusPill>
        </div>
        <h1 style={chatTitleStyle}>{move.title}</h1>
        {subtitle ? <p style={chatSubtitleStyle}>{subtitle}</p> : null}
        <div style={{ ...chatDividerStyle, marginTop: 20 }} />
        <div style={messagesStyle}>
          {messages.map((message) => (
            <div
              key={message.id}
              style={{
                ...messageRowStyle,
                justifyContent: message.role === "merchant" ? "flex-end" : "flex-start",
              }}
            >
              {message.role !== "merchant" ? <span style={smallMarkStyle}>J</span> : null}
              <div style={message.role === "merchant" ? merchantBubbleStyle : assistantBubbleStyle}>
                {message.content}
              </div>
            </div>
          ))}
          {pendingMessage ? (
            <div style={{ ...messageRowStyle, justifyContent: "flex-end" }}>
              <div style={merchantBubbleStyle}>{pendingMessage}</div>
            </div>
          ) : null}
          {isThinking ? (
            <div style={messageRowStyle} aria-live="polite">
              <span style={smallMarkStyle}>J</span>
              <div style={thinkingStyle}>Thinking</div>
            </div>
          ) : null}
          <div ref={bottomRef} aria-hidden="true" />
        </div>
        <div style={chatComposerWrapStyle}>
          <div style={chipsStyle}>
            <ChatPrompt message="Why this one?" move={move} />
            <ChatPrompt message="What exactly would you order?" move={move} />
            {move.actionRunId ? (
              <Form method="post">
                <input type="hidden" name="intent" value="action.revise_scope" />
                <input type="hidden" name="actionRunId" value={move.actionRunId} />
                <input type="hidden" name="recommendationId" value={move.recommendationId ?? ""} />
                <input type="hidden" name="maxProducts" value="1" />
                <ChipButton>Can we do just one product?</ChipButton>
              </Form>
            ) : null}
            {move.actionRunId ? (
              <Form method="post">
                <input type="hidden" name="intent" value="action.defer" />
                <input type="hidden" name="actionRunId" value={move.actionRunId} />
                <input type="hidden" name="reason" value="defer" />
                <ChipButton>Maybe later</ChipButton>
              </Form>
            ) : null}
          </div>
          <ChatComposer
            intent="action.chat.message"
            placeholder="Ask about this move, or tell me what to change..."
            ariaLabel="Ask about this move"
            value={composerMessage}
            onChange={setComposerMessage}
            disabled={isThinking}
            hiddenFields={<MoveHiddenFields move={move} />}
          />
          <div style={decisionRowStyle}>
            {move.actionRunId && move.executable ? (
              <Form method="post">
                <input type="hidden" name="intent" value="action.approve" />
                <input type="hidden" name="actionRunId" value={move.actionRunId} />
                <button type="submit" style={approveButtonStyle}>
                  Approve
                </button>
              </Form>
            ) : null}
            {move.actionRunId ? (
              <Form method="post">
                <input type="hidden" name="intent" value="action.defer" />
                <input type="hidden" name="actionRunId" value={move.actionRunId} />
                <input type="hidden" name="reason" value="defer" />
                <button type="submit" style={quietDecisionButtonStyle}>
                  Not right now
                </button>
              </Form>
            ) : null}
            {!move.actionRunId || !move.executable ? (
              <span style={{ color: COLORS.muted, fontWeight: 700 }}>
                This move is advisory until a typed action preview is available.
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </main>
  );
}

function ChatPrompt({ message, move }: { message: string; move: PrimaryMove }) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="action.chat.message" />
      <MoveHiddenFields move={move} />
      <input type="hidden" name="message" value={message} />
      <ChipButton>{message}</ChipButton>
    </Form>
  );
}

// Suggested openers under the home composer — they post the store-level chat.message
// intent (the same path the composer uses), so an empty thread still invites a real
// question. Grounded and generic (never a fabricated claim); Jefe answers each.
function StorePrompt({ message }: { message: string }) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="chat.message" />
      <input type="hidden" name="message" value={message} />
      <ChipButton>{message}</ChipButton>
    </Form>
  );
}

function MoveHiddenFields({ move }: { move: PrimaryMove }) {
  return (
    <>
      <input type="hidden" name="actionRunId" value={move.actionRunId ?? ""} />
      <input type="hidden" name="recommendationId" value={move.recommendationId ?? ""} />
    </>
  );
}

function ChipButton({ children }: { children: ReactNode }) {
  return (
    <button type="submit" style={chipStyle}>
      {children}
    </button>
  );
}

// useLayoutEffect on the client (runs before paint, so the open-at-latest scroll isn't a
// visible jump), plain useEffect on the server (where layout effects don't run anyway).
const useIsoLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

// Keep the conversation anchored to its LATEST message: a chat should open at the most
// recent exchange, not the oldest. On first mount it scrolls the bottom into view before
// paint (no jump). When a new message arrives it follows only if the merchant is already
// near the bottom — never yanking them away from history they've scrolled up to read.
// `signal` is a value that changes whenever the thread does (its message count).
function useStickToBottom(signal: number) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const initialisedRef = useRef(false);
  useIsoLayoutEffect(() => {
    const el = bottomRef.current;
    if (!el) return;
    if (!initialisedRef.current) {
      initialisedRef.current = true;
      el.scrollIntoView({ block: "end" });
      return;
    }
    const nearBottom =
      window.innerHeight + window.scrollY >= document.body.scrollHeight - 240;
    if (nearBottom) el.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [signal]);
  return bottomRef;
}

// The chat composer, shared by the home thread and the per-move zoom. A textarea (not a
// single-line input) that auto-grows to its content up to a cap; Enter sends, Shift+Enter
// inserts a newline, and Enter is ignored mid-IME-composition. Clears the draft ON SUBMIT
// (not when the reply lands) — the FormData is already captured by the time onSubmit fires,
// so the sent value is intact and the box empties immediately instead of sitting full
// through "Thinking" (which read as "it didn't send"). The parent owns the draft state.
function ChatComposer({
  intent,
  placeholder,
  ariaLabel,
  value,
  onChange,
  disabled,
  hiddenFields,
}: {
  intent: string;
  placeholder: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  hiddenFields?: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);
  return (
    <Form
      ref={formRef}
      method="post"
      style={composerFormStyle}
      onSubmit={() => onChange("")}
    >
      <input type="hidden" name="intent" value={intent} />
      {hiddenFields}
      <textarea
        ref={textareaRef}
        name="message"
        required
        rows={1}
        autoComplete="off"
        aria-label={ariaLabel}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (value.trim()) formRef.current?.requestSubmit();
          }
        }}
        style={composerTextareaStyle}
        disabled={disabled}
      />
      <button type="submit" style={sendButtonStyle} disabled={disabled}>
        Send
      </button>
    </Form>
  );
}

function StatusPill({ tone, children }: { tone: "yellow" | "green"; children: ReactNode }) {
  const green = tone === "green";
  return (
    <span
      style={{
        ...pillStyle,
        background: green ? COLORS.greenWash : COLORS.yellow,
        borderColor: green ? COLORS.greenBorder : COLORS.yellow,
        color: green ? COLORS.green : "#111827",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: 999,
          background: "currentColor",
          flex: "none",
        }}
      />
      {children}
    </span>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <span style={monoStyle}>{children}</span>;
}

function DateLabel({ children }: { children: ReactNode }) {
  return <span style={dateStyle}>{children}</span>;
}

function buildPrimaryMove(input: {
  recommendation: Recommendation;
  suggestedAction: SuggestedAction | null;
  actions: ExecutedAction[];
  goals: Goal[];
  storeTimeZone?: string | null;
}): PrimaryMove {
  const inProgress = input.actions.find(
    (action) =>
      (action.status === "applied" || action.status === "partially_applied") &&
      action.outcome.measured === false,
  );
  const source =
    input.suggestedAction?.sourceRecommendation ??
    inProgress?.sourceRecommendation ??
    recommendationSource(input.recommendation);
  if (!source && !input.suggestedAction && !inProgress) {
    return {
      title: "Nothing's on fire - you're all clear.",
      summary: "",
      whyThisAction: "",
      whyNow: "",
      successSignal: null,
      recommendationId: null,
      recommendationRunId: null,
      actionRunId: null,
      actionType: null,
      executable: false,
      state: "empty",
      statusLabel: "All clear",
      statusTone: "green",
      approvedAt: null,
      baselineSignal: null,
      currentSignal: null,
    };
  }

  const title = source?.title || input.suggestedAction?.headline || inProgress?.headline || "Review Jefe's next move";
  const summary = source?.summary || input.suggestedAction?.headline || "Jefe has a move ready to discuss.";
  const success = successSignalText(source?.successSignal ?? input.recommendation?.successSignal ?? null);
  if (inProgress && !input.suggestedAction) {
    return {
      title,
      summary,
      whyThisAction: source?.whyThisAction || "",
      whyNow: source?.whyNow || "",
      successSignal: success,
      recommendationId: source?.id ?? null,
      recommendationRunId: source?.runId ?? null,
      actionRunId: inProgress.actionRunId,
      actionType: inProgress.actionType,
      executable: false,
      state: "in_progress",
      statusLabel: `Approved ${formatShortDate(inProgress.appliedAt, input.storeTimeZone)}`,
      statusTone: "green",
      approvedAt: inProgress.appliedAt,
      baselineSignal: inProgress.baselineSignal ?? null,
      currentSignal: inProgress.currentSignal ?? inProgress.baselineSignal ?? null,
    };
  }

  return {
    title,
    summary,
    whyThisAction: source?.whyThisAction || input.recommendation?.whyThisAction || "",
    whyNow: source?.whyNow || input.recommendation?.whyNow || "",
    successSignal: goalTitle(source?.primaryGoalId ?? input.recommendation?.primaryGoalId ?? null, input.goals) ?? success,
    recommendationId: source?.id ?? input.recommendation?.id ?? null,
    recommendationRunId: source?.runId ?? input.recommendation?.runId ?? null,
    actionRunId: input.suggestedAction?.actionRunId ?? null,
    actionType: input.suggestedAction?.actionType ?? null,
    executable: input.suggestedAction?.executable ?? false,
    state: "proposed",
    statusLabel: "Needs your OK",
    statusTone: "yellow",
    approvedAt: null,
    baselineSignal: baselineFromSuggested(input.suggestedAction),
    currentSignal: baselineFromSuggested(input.suggestedAction),
  };
}

function recommendationSource(recommendation: Recommendation) {
  if (!recommendation) return null;
  return {
    id: recommendation.id ?? null,
    runId: recommendation.runId ?? null,
    title: recommendation.title,
    summary: recommendation.summary,
    whyThisAction: recommendation.whyThisAction,
    whyNow: recommendation.whyNow,
    successSignal: recommendation.successSignal,
    primaryGoalId: recommendation.primaryGoalId ?? null,
  };
}

function baselineFromSuggested(action: SuggestedAction | null) {
  const products = action?.keyNumbers?.find((item) => item.label === "Products")?.value;
  const trapped = action?.keyNumbers?.find((item) => item.label === "Trapped capital")?.value;
  if (products && trapped) return `${products} product${products === "1" ? "" : "s"} · ${trapped} tied up`;
  return null;
}

type SuccessSignalLike = {
  description?: unknown;
  timeframe?: unknown;
  target?: unknown;
} | null;

function successSignalText(signal: SuccessSignalLike) {
  if (!signal || typeof signal !== "object") return null;
  const description = typeof signal.description === "string" ? signal.description : "";
  const timeframe = typeof signal.timeframe === "string" ? signal.timeframe : "";
  const target = typeof signal.target === "string" ? signal.target : "";
  return [description, target, timeframe].filter(Boolean).join(" · ") || null;
}

function informativeSubtitle(summary: string, title: string) {
  const cleanSummary = summary.replace(/\s+/g, " ").trim();
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  if (!cleanSummary) return null;
  if (cleanSummary.toLocaleLowerCase() === cleanTitle.toLocaleLowerCase()) return null;
  return cleanSummary;
}

function goalTitle(goalId: string | null, goals: Goal[]) {
  if (!goalId) return null;
  return goals.find((goal) => goal.id === goalId)?.title ?? null;
}

// A short "12 Aug" label for a fixed instant, pinned to the STORE's timezone (the
// service zone for a per-merchant app), falling back to London when it isn't known —
// never the viewer's browser zone. Fixed instant + pinned zone ⇒ hydration-safe.
// The current-day header label is separate: computed once in the loader
// (computeHomeDateLabel) and passed as `todayLabel`, never read from the clock here.
function formatShortDate(value: string | null | undefined, timeZone?: string | null) {
  return formatDateInZone({ iso: value ?? null, timeZone: timeZone ?? undefined });
}

function searchWith(search: string, updates: Record<string, string | null>) {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const next = params.toString();
  return next ? `?${next}` : "/app";
}

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background: COLORS.page,
  color: COLORS.ink,
  fontFamily: FONT.sans,
  padding: "48px 24px 96px",
};
const shellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 40,
  maxWidth: 760,
  margin: "0 auto",
  width: "100%",
};
// Widened when the conversation index is present, to fit the rail + the 760px thread.
const shellWideStyle: CSSProperties = { ...shellStyle, maxWidth: 992 };
const homeGridStyle: CSSProperties = {
  display: "flex",
  gap: 28,
  alignItems: "flex-start",
};
const homeMainColStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  maxWidth: 760,
  display: "flex",
  flexDirection: "column",
  gap: 40,
};
const indexRailStyle: CSSProperties = {
  flex: "none",
  width: 204,
  position: "sticky",
  top: 24,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};
const indexHeadingStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 11,
  fontWeight: 600,
  padding: "0 8px 4px",
};
const indexListStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 1 };
const indexEntryStyle: CSSProperties = {
  alignItems: "flex-start",
  background: "transparent",
  border: 0,
  borderRadius: 8,
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  fontFamily: FONT.sans,
  gap: 2,
  padding: "8px 8px",
  textAlign: "left",
  width: "100%",
};
const indexEntryLabelStyle: CSSProperties = {
  color: COLORS.ink,
  fontSize: 12.5,
  lineHeight: 1.3,
};
const indexEntryMetaStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 11,
};
// The index is desktop wayfinding; on a narrow embedded viewport it would crowd the
// thread, so hide it and let the conversation take the full width.
const HOME_INDEX_RESPONSIVE_CSS =
  "@media (max-width: 760px){.jefe-home-index{display:none}.jefe-home-grid{display:block}}";
const chatShellStyle: CSSProperties = {
  maxWidth: 760,
  minHeight: "calc(100vh - 96px)",
  margin: "0 auto",
  display: "flex",
  flexDirection: "column",
  width: "100%",
};
const headerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 24,
};
const markStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: COLORS.navy,
  color: "#fff",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 800,
};
const smallMarkStyle: CSSProperties = { ...markStyle, width: 22, height: 22, borderRadius: 6, fontSize: 12, flex: "none" };
const logoMarkStyle: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  objectFit: "contain",
  background: "#fff",
  border: `1px solid ${COLORS.border}`,
  display: "block",
  flex: "none",
};
const monoStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
};
const dateStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 12,
  fontWeight: 500,
  letterSpacing: 0,
  whiteSpace: "nowrap",
};
const goalLineStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 12.5,
  fontWeight: 600,
  letterSpacing: "0.01em",
};
const headlineStyle: CSSProperties = {
  fontFamily: FONT.serif,
  fontSize: 40,
  lineHeight: 1.15,
  fontWeight: 500,
  margin: 0,
  letterSpacing: 0,
};
const headlineEmStyle: CSSProperties = { color: COLORS.navy, fontStyle: "italic" };
const cardStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 16,
  boxShadow: "0 16px 42px rgba(39,55,77,0.08)",
  display: "flex",
  flexDirection: "column",
  gap: 22,
  padding: "clamp(24px, 3.5vw, 40px)",
};
const cardTopStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 20,
};
const summaryStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 16,
  lineHeight: 1.55,
  margin: 0,
  maxWidth: 760,
};
const primaryButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  alignSelf: "flex-start",
  background: COLORS.navy,
  color: "#fff",
  borderRadius: 8,
  padding: "12px 22px",
  fontSize: 14,
  fontWeight: 700,
  textDecoration: "none",
};
const pillStyle: CSSProperties = {
  alignItems: "center",
  border: "1px solid",
  borderRadius: 8,
  display: "inline-flex",
  gap: 7,
  fontSize: 12,
  fontWeight: 700,
  padding: "6px 14px",
  whiteSpace: "nowrap",
};
const chatTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};
const backLinkStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 14,
  fontWeight: 700,
  textDecoration: "none",
};
const chatTitleStyle: CSSProperties = {
  fontFamily: FONT.serif,
  fontSize: 26,
  lineHeight: 1.28,
  margin: "14px 0 0",
  fontWeight: 500,
};
const chatSubtitleStyle: CSSProperties = {
  ...summaryStyle,
  fontSize: 15.5,
  marginTop: 10,
};
const chatDividerStyle: CSSProperties = { borderTop: `1px solid ${COLORS.hairline}` };
const messagesStyle: CSSProperties = {
  flex: "1 1 auto",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: "24px 0",
};
const messageRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
};
const assistantBubbleStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 15,
  lineHeight: 1.6,
  maxWidth: "86%",
  whiteSpace: "pre-wrap",
};
const merchantBubbleStyle: CSSProperties = {
  background: COLORS.navy,
  borderRadius: 18,
  color: "#fff",
  fontSize: 15,
  lineHeight: 1.6,
  maxWidth: "76%",
  padding: "11px 16px",
  whiteSpace: "pre-wrap",
};
// Quiet by design — the home is a chat log, and the way out should be findable without
// competing with what Jefe is saying.
const gearLinkStyle: CSSProperties = {
  alignItems: "center",
  color: COLORS.meta,
  display: "flex",
  justifyContent: "center",
  padding: 4,
  textDecoration: "none",
};
const thinkingStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 15,
  lineHeight: 1.6,
  paddingTop: 1,
};
// Deliberately NOT an alarm colour. Jefe not getting to a message is a hiccup in a
// conversation, not a store problem — dressing it in red would tell the merchant something
// is wrong with their business.
const replyFailedBubbleStyle: CSSProperties = {
  ...assistantBubbleStyle,
  alignItems: "flex-start",
  color: COLORS.muted,
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
};
const replyRetryButtonStyle: CSSProperties = {
  background: "transparent",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 999,
  color: COLORS.ink,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
  lineHeight: 1.2,
  padding: "5px 12px",
};
const chatComposerWrapStyle: CSSProperties = {
  flex: "none",
  paddingTop: 16,
};
const conversationStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};
const moveMessageStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 16,
  boxShadow: "0 14px 36px rgba(39,55,77,0.06)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  maxWidth: "86%",
  padding: "18px 20px",
};
const moveMessageTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontSize: 17,
  fontWeight: 700,
  lineHeight: 1.3,
};
const moveMessageSummaryStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 14.5,
  lineHeight: 1.55,
  margin: 0,
};
const moveMessageActionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 14,
  marginTop: 4,
};
const chipsStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 7,
  marginBottom: 14,
};
const chipStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 999,
  color: COLORS.body,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 13,
  fontWeight: 700,
  padding: "8px 10px",
};
const composerStyle: CSSProperties = {
  alignItems: "center",
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 12,
  display: "flex",
  gap: 10,
  padding: "8px 8px 8px 16px",
  boxShadow: "0 14px 36px rgba(39,55,77,0.06)",
};
const composerInputStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  color: COLORS.ink,
  flex: 1,
  fontFamily: FONT.sans,
  fontSize: 14.5,
  minWidth: 0,
  outline: "none",
  padding: 0,
};
// The composer wrapper aligns Send to the BOTTOM so it stays put as the textarea grows.
const composerFormStyle: CSSProperties = { ...composerStyle, alignItems: "flex-end" };
const composerTextareaStyle: CSSProperties = {
  ...composerInputStyle,
  resize: "none",
  overflowY: "auto",
  maxHeight: 140,
  lineHeight: 1.45,
  paddingTop: 6,
  paddingBottom: 6,
};
const sendButtonStyle: CSSProperties = {
  background: COLORS.navy,
  border: 0,
  borderRadius: 9,
  color: "#fff",
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 14,
  fontWeight: 700,
  padding: "10px 18px",
};
const decisionRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 18,
  marginTop: 16,
};
const approveButtonStyle: CSSProperties = {
  ...sendButtonStyle,
  borderRadius: 8,
  padding: "12px 22px",
};
const quietDecisionButtonStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  color: COLORS.muted,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 14,
  fontWeight: 700,
  padding: "12px 0",
};
