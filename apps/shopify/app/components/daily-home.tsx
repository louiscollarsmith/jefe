import {
  Form,
  Link,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import {
  ActionList,
  Button,
  InlineStack,
  Popover,
  Text,
} from "@shopify/polaris";
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

// A proactive heads-up Jefe posts into the thread from a standing condition (a run-out
// approaching, refunds trending). Re-rendered from current state each load — not stored —
// so it stays honest and can't go stale. Kept deliberately small (see the cap in
// StoreConversation): the chat is not a notification feed.
type HeadsUp = { id: string; kind: string; text: string };
type ChatConversation = {
  id: string;
  conversationType: string;
  surface: string;
  title: string;
  lastMessageAt: string;
  createdAt: string;
};
type ChatThread = {
  conversation: ChatConversation | null;
  conversations: ChatConversation[];
  messages: Array<{ id: string; role: string; content: string }>;
};
type ChannelConn = {
  provider: string;
  connected: boolean;
  maskedDestination?: string | null;
  accountName?: string | null;
};
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
  changelog?: Array<{
    id: string;
    date: string;
    text: string;
    tag?: string | null;
    body?: string | null;
  }>;
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

  return (
    <main style={pageStyle}>
      <div style={shellStyle}>
        <Header
          storeName={props.storeName}
          todayLabel={props.todayLabel}
          goalLine={goalLine}
          brandLogoUrl={props.brandLogoUrl}
        />
        <StoreConversation
          conversation={props.conversation ?? null}
          move={primaryMove}
          outcomes={outcomes}
          headsUps={props.horizonHeadsUps ?? []}
          quietLine={buildQuietLine(props.horizonWatching, props.insights)}
          currentSearch={location.search}
        />
        {/* The one door off the chat log: everything Jefe knows about the store. */}
        <Link to="?view=memory" style={footerLinkStyle}>
          See everything Jefe knows →
        </Link>
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
  const navigate = useNavigate();
  const pendingIntent = navigation.formData?.get("intent");
  const isThinking =
    navigation.state !== "idle" && pendingIntent === "chat.message";
  const pendingMessage =
    isThinking && typeof navigation.formData?.get("message") === "string"
      ? String(navigation.formData.get("message")).trim()
      : "";
  const [composerMessage, setComposerMessage] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const submittedMessageRef = useRef("");
  useEffect(() => {
    if (isThinking && pendingMessage)
      submittedMessageRef.current = pendingMessage;
  }, [isThinking, pendingMessage]);
  useEffect(() => {
    if (!isThinking && submittedMessageRef.current) {
      if (composerMessage.trim() === submittedMessageRef.current)
        setComposerMessage("");
      submittedMessageRef.current = "";
    }
  }, [isThinking, composerMessage]);

  const history = conversation?.messages ?? [];
  const hasMove = move.state !== "empty";
  // Budget: at most 2 proactive heads-ups — the chat is a conversation, not a
  // notification feed. These are Horizon's top-ranked standing conditions; dedup is
  // inherent because they're re-derived from state each load, never stored.
  const shownHeadsUps = headsUps.slice(0, 2);
  // The grounded fallback line shows ONLY when there is genuinely nothing real to say —
  // no move, no reports, no history, no heads-up. Silence-with-a-real-line, never filler.
  const showQuietLine =
    !hasMove &&
    outcomes.length === 0 &&
    history.length === 0 &&
    shownHeadsUps.length === 0;

  return (
    <section style={conversationStyle}>
      <div style={threadControlsStyle}>
        <InlineStack
          align="space-between"
          blockAlign="center"
          gap="300"
          wrap={false}
        >
          <div style={{ minWidth: 0 }}>
            <Text as="h2" variant="headingSm" truncate>
              {conversation?.conversation?.title ?? "New conversation"}
            </Text>
          </div>
          <InlineStack gap="200" wrap={false}>
            <Popover
              active={historyOpen}
              onClose={() => setHistoryOpen(false)}
              activator={
                <Button
                  disclosure
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  History
                </Button>
              }
              preferredAlignment="right"
            >
              <ActionList
                actionRole="menuitem"
                items={
                  (conversation?.conversations.length ?? 0) > 0
                    ? (conversation?.conversations ?? []).map((item) => ({
                        content: item.title,
                        active: item.id === conversation?.conversation?.id,
                        helpText: formatConversationDate(item.lastMessageAt),
                        onAction: () => {
                          setHistoryOpen(false);
                          navigate(
                            searchWith(currentSearch, {
                              conversation: item.id,
                            }),
                          );
                        },
                      }))
                    : [{ content: "No earlier chats yet", disabled: true }]
                }
              />
            </Popover>
            <Form method="post">
              <input type="hidden" name="intent" value="chat.new" />
              <Button submit disabled={navigation.state !== "idle"}>
                New chat
              </Button>
            </Form>
          </InlineStack>
        </InlineStack>
      </div>
      <div style={messagesStyle}>
        {history.map((message) => (
          <MessageRow key={message.id} from={message.role}>
            {message.content}
          </MessageRow>
        ))}
        {outcomes.map((action) => (
          <MessageRow key={action.actionRunId} from="assistant">
            {outcomeMessageText(action)}
          </MessageRow>
        ))}
        {shownHeadsUps.map((headsUp) => (
          <MessageRow key={headsUp.id} from="assistant">
            {headsUp.text}
          </MessageRow>
        ))}
        {hasMove ? (
          <MoveMessage move={move} currentSearch={currentSearch} />
        ) : null}
        {showQuietLine ? (
          <MessageRow from="assistant">{quietLine}</MessageRow>
        ) : null}
        {pendingMessage ? (
          <MessageRow from="merchant">{pendingMessage}</MessageRow>
        ) : null}
        {isThinking ? (
          <div style={messageRowStyle} aria-live="polite">
            <span style={smallMarkStyle}>J</span>
            <div style={thinkingStyle}>Thinking</div>
          </div>
        ) : null}
      </div>
      <div style={chatComposerWrapStyle}>
        <Form method="post" style={composerStyle}>
          <input type="hidden" name="intent" value="chat.message" />
          <input
            type="hidden"
            name="conversationId"
            value={conversation?.conversation?.id ?? ""}
          />
          <input
            name="message"
            required
            autoComplete="off"
            aria-label="Message Jefe"
            placeholder="Ask Jefe anything, or tell me what changed…"
            value={composerMessage}
            onChange={(event) => setComposerMessage(event.currentTarget.value)}
            style={composerInputStyle}
            disabled={isThinking}
          />
          <button type="submit" style={sendButtonStyle} disabled={isThinking}>
            {isThinking ? "Thinking" : "Send"}
          </button>
        </Form>
      </div>
    </section>
  );
}

function formatConversationDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
      }).format(date);
}

function MessageRow({ from, children }: { from: string; children: ReactNode }) {
  const isMerchant = from === "merchant" || from === "user";
  return (
    <div
      style={{
        ...messageRowStyle,
        justifyContent: isMerchant ? "flex-end" : "flex-start",
      }}
    >
      {!isMerchant ? <span style={smallMarkStyle}>J</span> : null}
      <div style={isMerchant ? merchantBubbleStyle : assistantBubbleStyle}>
        {children}
      </div>
    </div>
  );
}

// The move as a message in the thread: enough to recognise it, with a zoom into its
// own action chat ("Talk this through →" sets ?actionChat=<id>) where the merchant
// approves, declines or revises it. The decision never happens on the home feed.
function MoveMessage({
  move,
  currentSearch,
}: {
  move: PrimaryMove;
  currentSearch: string;
}) {
  const chatTarget = move.recommendationId ?? move.actionRunId ?? "move";
  const subtitle = informativeSubtitle(move.summary, move.title);
  return (
    <div style={{ ...messageRowStyle, justifyContent: "flex-start" }}>
      <span style={smallMarkStyle}>J</span>
      <div style={moveMessageStyle}>
        <div style={cardTopStyle}>
          <Mono>
            {move.state === "in_progress" ? "IN PROGRESS" : "YOUR NEXT MOVE"}
          </Mono>
          <StatusPill tone={move.statusTone}>{move.statusLabel}</StatusPill>
        </div>
        <strong style={moveMessageTitleStyle}>{move.title}</strong>
        {subtitle ? <p style={moveMessageSummaryStyle}>{subtitle}</p> : null}
        {/* Approve / decline / revise live in the move's own chat (the zoom level), never on
            the home feed — an executable commitment happens in the focused surface. */}
        <div style={moveMessageActionsStyle}>
          <Link
            to={searchWith(currentSearch, { actionChat: chatTarget })}
            style={primaryButtonStyle}
          >
            Talk this through →
          </Link>
        </div>
      </div>
    </div>
  );
}

// Jefe reporting back on a move already made — honest copy from the same fields the
// old Action history / Also-in-progress cards used, now rendered as a thread message.
function outcomeMessageText(action: ExecutedAction): string {
  const name = action.sourceRecommendation?.title || action.headline;
  if (action.status === "rejected") {
    return (
      action.declineLearning ??
      `You passed on “${name}” — I've noted it wasn't right for now.`
    );
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
function buildQuietLine(
  horizonWatching: HorizonWatch[],
  insights: Insight[],
): string {
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
          <div
            style={{
              height: 24,
              maxWidth: 420,
              background: COLORS.hairline,
              borderRadius: 8,
            }}
          />
          <div
            style={{
              height: 16,
              maxWidth: 580,
              background: COLORS.hairline,
              borderRadius: 8,
              marginTop: 22,
            }}
          />
          <div
            style={{
              height: 16,
              maxWidth: 500,
              background: COLORS.hairline,
              borderRadius: 8,
              marginTop: 10,
            }}
          />
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
}: {
  storeName: string;
  todayLabel?: string;
  goalLine?: string | null;
  brandLogoUrl?: string | null;
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
      <DateLabel>{todayLabel ?? ""}</DateLabel>
    </header>
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
  const submittedMessageRef = useRef("");
  useEffect(() => {
    if (isThinking && pendingMessage)
      submittedMessageRef.current = pendingMessage;
  }, [isThinking, pendingMessage]);
  useEffect(() => {
    if (!isThinking && submittedMessageRef.current) {
      if (composerMessage.trim() === submittedMessageRef.current)
        setComposerMessage("");
      submittedMessageRef.current = "";
    }
  }, [isThinking, composerMessage]);
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
  return (
    <main style={pageStyle}>
      <div style={chatShellStyle}>
        <div style={chatTopStyle}>
          <Link to={backTo} style={backLinkStyle}>
            ← Back
          </Link>
          <DateLabel>{todayLabel ?? ""}</DateLabel>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            marginTop: 20,
          }}
        >
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
                justifyContent:
                  message.role === "merchant" ? "flex-end" : "flex-start",
              }}
            >
              {message.role !== "merchant" ? (
                <span style={smallMarkStyle}>J</span>
              ) : null}
              <div
                style={
                  message.role === "merchant"
                    ? merchantBubbleStyle
                    : assistantBubbleStyle
                }
              >
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
        </div>
        <div style={chatComposerWrapStyle}>
          <div style={chipsStyle}>
            <ChatPrompt message="Why this one?" move={move} />
            <ChatPrompt message="What exactly would you order?" move={move} />
            {move.actionRunId ? (
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="action.revise_scope"
                />
                <input
                  type="hidden"
                  name="actionRunId"
                  value={move.actionRunId}
                />
                <input
                  type="hidden"
                  name="recommendationId"
                  value={move.recommendationId ?? ""}
                />
                <input type="hidden" name="maxProducts" value="1" />
                <ChipButton>Can we do just one product?</ChipButton>
              </Form>
            ) : null}
            {move.actionRunId ? (
              <Form method="post">
                <input type="hidden" name="intent" value="action.defer" />
                <input
                  type="hidden"
                  name="actionRunId"
                  value={move.actionRunId}
                />
                <input type="hidden" name="reason" value="defer" />
                <ChipButton>Maybe later</ChipButton>
              </Form>
            ) : null}
          </div>
          <Form method="post" style={composerStyle}>
            <input type="hidden" name="intent" value="action.chat.message" />
            <MoveHiddenFields move={move} />
            <input
              name="message"
              required
              autoComplete="off"
              aria-label="Ask about this move"
              placeholder="Ask about this move, or tell me what to change..."
              value={composerMessage}
              onChange={(event) =>
                setComposerMessage(event.currentTarget.value)
              }
              style={composerInputStyle}
              disabled={isThinking}
            />
            <button type="submit" style={sendButtonStyle} disabled={isThinking}>
              {isThinking ? "Thinking" : "Send"}
            </button>
          </Form>
          <div style={decisionRowStyle}>
            {move.actionRunId && move.executable ? (
              <Form method="post">
                <input type="hidden" name="intent" value="action.approve" />
                <input
                  type="hidden"
                  name="actionRunId"
                  value={move.actionRunId}
                />
                <button type="submit" style={approveButtonStyle}>
                  Approve
                </button>
              </Form>
            ) : null}
            {move.actionRunId ? (
              <Form method="post">
                <input type="hidden" name="intent" value="action.defer" />
                <input
                  type="hidden"
                  name="actionRunId"
                  value={move.actionRunId}
                />
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

function MoveHiddenFields({ move }: { move: PrimaryMove }) {
  return (
    <>
      <input type="hidden" name="actionRunId" value={move.actionRunId ?? ""} />
      <input
        type="hidden"
        name="recommendationId"
        value={move.recommendationId ?? ""}
      />
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

function StatusPill({
  tone,
  children,
}: {
  tone: "yellow" | "green";
  children: ReactNode;
}) {
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

  const title =
    source?.title ||
    input.suggestedAction?.headline ||
    inProgress?.headline ||
    "Review Jefe's next move";
  const summary =
    source?.summary ||
    input.suggestedAction?.headline ||
    "Jefe has a move ready to discuss.";
  const success = successSignalText(
    source?.successSignal ?? input.recommendation?.successSignal ?? null,
  );
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
      currentSignal:
        inProgress.currentSignal ?? inProgress.baselineSignal ?? null,
    };
  }

  return {
    title,
    summary,
    whyThisAction:
      source?.whyThisAction || input.recommendation?.whyThisAction || "",
    whyNow: source?.whyNow || input.recommendation?.whyNow || "",
    successSignal:
      goalTitle(
        source?.primaryGoalId ?? input.recommendation?.primaryGoalId ?? null,
        input.goals,
      ) ?? success,
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
  const products = action?.keyNumbers?.find(
    (item) => item.label === "Products",
  )?.value;
  const trapped = action?.keyNumbers?.find(
    (item) => item.label === "Trapped capital",
  )?.value;
  if (products && trapped)
    return `${products} product${products === "1" ? "" : "s"} · ${trapped} tied up`;
  return null;
}

type SuccessSignalLike = {
  description?: unknown;
  timeframe?: unknown;
  target?: unknown;
} | null;

function successSignalText(signal: SuccessSignalLike) {
  if (!signal || typeof signal !== "object") return null;
  const description =
    typeof signal.description === "string" ? signal.description : "";
  const timeframe =
    typeof signal.timeframe === "string" ? signal.timeframe : "";
  const target = typeof signal.target === "string" ? signal.target : "";
  return [description, target, timeframe].filter(Boolean).join(" · ") || null;
}

function informativeSubtitle(summary: string, title: string) {
  const cleanSummary = summary.replace(/\s+/g, " ").trim();
  const cleanTitle = title.replace(/\s+/g, " ").trim();
  if (!cleanSummary) return null;
  if (cleanSummary.toLocaleLowerCase() === cleanTitle.toLocaleLowerCase())
    return null;
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
function formatShortDate(
  value: string | null | undefined,
  timeZone?: string | null,
) {
  return formatDateInZone({
    iso: value ?? null,
    timeZone: timeZone ?? undefined,
  });
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
const smallMarkStyle: CSSProperties = {
  ...markStyle,
  width: 22,
  height: 22,
  borderRadius: 6,
  fontSize: 12,
  flex: "none",
};
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
const headlineEmStyle: CSSProperties = {
  color: COLORS.navy,
  fontStyle: "italic",
};
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
const footerLinkStyle: CSSProperties = {
  color: COLORS.navy,
  display: "block",
  fontSize: 14.5,
  fontWeight: 700,
  textAlign: "right",
  textDecoration: "none",
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
const chatDividerStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.hairline}`,
};
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
const thinkingStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 15,
  lineHeight: 1.6,
  paddingTop: 1,
};
const chatComposerWrapStyle: CSSProperties = {
  flex: "none",
  paddingTop: 16,
};
const conversationStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const threadControlsStyle: CSSProperties = {
  borderBottom: `1px solid ${COLORS.hairline}`,
  padding: "14px 16px",
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
