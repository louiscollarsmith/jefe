import {
  Form,
  Link,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";
import { useState } from "react";
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

type IndexEntry = {
  id: string;
  label: string;
  kind: string;
  dateLabel: string;
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

  // The home is the store-level conversation. Only canonical conversation messages
  // appear in its transcript; live store signals, action outcomes and the proposed
  // move stay reachable through Store updates without masquerading as chat history.
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
          currentSearch={location.search}
        />
        <StoreConversation
          conversation={props.conversation ?? null}
          move={primaryMove}
          outcomes={outcomes}
          headsUps={props.horizonHeadsUps ?? []}
          quietLine={buildQuietLine(props.horizonWatching, props.insights)}
          currentSearch={location.search}
          storeTimeZone={props.storeTimeZone}
        />
        {/* The one door off the chat log: everything Jefe knows about the store. */}
        <Link to="?view=memory" style={footerLinkStyle}>
          See everything Jefe knows →
        </Link>
      </div>
    </main>
  );
}

// The store-level conversation. The transcript is only the selected conversation's
// real messages, so a newly created chat is visibly and genuinely blank. Derived
// signals and proposed work live in the separate Store updates popover. The composer
// posts `chat.message`; the per-move zoom posts `action.chat.message`.
function StoreConversation({
  conversation,
  move,
  outcomes,
  headsUps,
  quietLine,
  currentSearch,
  storeTimeZone,
}: {
  conversation: ChatThread | null;
  move: PrimaryMove;
  outcomes: ExecutedAction[];
  headsUps: HeadsUp[];
  quietLine: string;
  currentSearch: string;
  storeTimeZone?: string | null;
}) {
  const navigation = useNavigation();
  const navigate = useNavigate();
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const handleComposerSubmit = () => setComposerMessage("");

  const history = conversation?.messages ?? [];
  const activeConversation = conversation?.conversation ?? null;
  // A reply that never arrived, detected from the THREAD rather than from the failed
  // request. The merchant's turn is stored before Jefe is asked, so a thread whose last
  // message is theirs means Jefe owes them an answer — and that stays true after a reload,
  // in a new tab, and after the route error boundary's own "Try again". Keying this off the
  // action result alone would lose the retry the moment the page reloaded, which is exactly
  // the "nothing to retry" gap.
  const lastMessage = history[history.length - 1];
  const awaitingReply =
    !isThinking &&
    !pendingMessage &&
    (lastMessage?.role === "merchant" || lastMessage?.role === "user");
  const isBlankThread = history.length === 0;
  // Budget: at most 2 proactive heads-ups — the chat is a conversation, not a
  // notification feed. These are Horizon's top-ranked standing conditions; dedup is
  // inherent because they're re-derived from state each load, never stored.
  const shownHeadsUps = headsUps.slice(0, 2);
  const displayedTitle = conversationTitle(activeConversation);
  const messageLabel = isBlankThread
    ? "Fresh chat · no messages yet"
    : `${history.length} message${history.length === 1 ? "" : "s"}`;
  const indexEntries = buildConversationIndex(
    outcomes,
    move,
    storeTimeZone,
  );

  return (
    <section style={conversationStyle}>
      <div style={threadControlsStyle}>
        <InlineStack
          align="space-between"
          blockAlign="start"
          gap="300"
          wrap
        >
          <div style={threadIdentityStyle}>
            <Mono>Current chat</Mono>
            <Text as="h2" variant="headingSm" truncate>
              {displayedTitle}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {messageLabel}
            </Text>
          </div>
          <InlineStack gap="200" wrap={false}>
            <Popover
              active={updatesOpen}
              onClose={() => setUpdatesOpen(false)}
              activator={
                <Button
                  disclosure
                  onClick={() => {
                    setHistoryOpen(false);
                    setUpdatesOpen((open) => !open);
                  }}
                >
                  Store updates
                </Button>
              }
              preferredAlignment="right"
            >
              <StoreUpdatesPopover
                move={move}
                outcomes={outcomes}
                headsUps={shownHeadsUps}
                quietLine={quietLine}
                currentSearch={currentSearch}
                onNavigate={() => setUpdatesOpen(false)}
              />
            </Popover>
            <Popover
              active={historyOpen}
              onClose={() => setHistoryOpen(false)}
              activator={
                <Button
                  disclosure
                  onClick={() => {
                    setUpdatesOpen(false);
                    setHistoryOpen((open) => !open);
                  }}
                >
                  Chats
                </Button>
              }
              preferredAlignment="right"
            >
              <ActionList
                actionRole="menuitem"
                items={
                  (conversation?.conversations.length ?? 0) > 0
                    ? (conversation?.conversations ?? []).map((item) => ({
                        content: conversationHistoryTitle(
                          item,
                          activeConversation?.id ?? null,
                        ),
                        active: item.id === activeConversation?.id,
                        helpText: formatConversationDate(
                          item.lastMessageAt,
                          storeTimeZone,
                        ),
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
              <Button
                submit
                disabled={
                  navigation.state !== "idle" ||
                  Boolean(activeConversation && isBlankThread)
                }
              >
                New chat
              </Button>
            </Form>
          </InlineStack>
        </InlineStack>
      </div>
      {indexEntries.length > 0 ? (
        <ConversationIndex entries={indexEntries} />
      ) : null}
      <div style={messagesStyle}>
        {outcomes.map((action) => (
          <ConversationMomentAnchor
            key={action.actionRunId}
            anchorId={`moment-${action.actionRunId}`}
          />
        ))}
        {move.state !== "empty" ? (
          <ConversationMomentAnchor
            anchorId={`moment-${move.recommendationId ?? move.actionRunId ?? "move"}`}
          />
        ) : null}
        {isBlankThread && !pendingMessage ? <EmptyChat /> : null}
        {history.map((message) => (
          <MessageRow key={message.id} from={message.role}>
            {message.content}
          </MessageRow>
        ))}
        {pendingMessage ? (
          <MessageRow from="merchant">{pendingMessage}</MessageRow>
        ) : null}
        {isThinking ? (
          <div style={messageRowStyle} aria-live="polite">
            <span style={smallMarkStyle}>J</span>
            <div style={thinkingStyle}>Thinking</div>
          </div>
        ) : null}
        {awaitingReply ? (
          <ReplyFailedRow conversationId={activeConversation?.id ?? null} />
        ) : null}
      </div>
      <div style={chatComposerWrapStyle}>
        <div style={chipsStyle}>
          <StorePrompt message="What changed this week?" conversationId={activeConversation?.id ?? null} />
          <StorePrompt message="Anything I should worry about?" conversationId={activeConversation?.id ?? null} />
          <StorePrompt message="How are my goals looking?" conversationId={activeConversation?.id ?? null} />
        </div>
        <Form
          method="post"
          style={composerStyle}
          onSubmit={handleComposerSubmit}
        >
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
          <button
            type="submit"
            style={sendButtonStateStyle(isThinking)}
            disabled={isThinking}
          >
            Send
          </button>
        </Form>
      </div>
    </section>
  );
}

function conversationTitle(conversation: ChatConversation | null) {
  if (!conversation || conversation.title === "New conversation")
    return "New chat";
  return conversation.title;
}

function conversationHistoryTitle(
  conversation: ChatConversation,
  activeId: string | null,
) {
  const title =
    conversation.title === "New conversation"
      ? "Empty chat"
      : conversation.title;
  return conversation.id === activeId ? `${title} · Current` : title;
}

function formatConversationDate(value: string, timeZone?: string | null) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timeZone ?? "Europe/London",
      }).format(date);
}

function EmptyChat() {
  return (
    <div style={emptyChatStyle}>
      <span style={emptyChatMarkStyle}>J</span>
      <Text as="h3" variant="headingMd">
        Start a new conversation
      </Text>
      <Text as="p" variant="bodyMd" tone="subdued">
        This chat is empty. Messages from earlier chats stay in Chats; Jefe can
        still use what it knows about your store when you ask.
      </Text>
    </div>
  );
}

function StoreUpdatesPopover({
  move,
  outcomes,
  headsUps,
  quietLine,
  currentSearch,
  onNavigate,
}: {
  move: PrimaryMove;
  outcomes: ExecutedAction[];
  headsUps: HeadsUp[];
  quietLine: string;
  currentSearch: string;
  onNavigate: () => void;
}) {
  const recentOutcomes = outcomes.slice(0, 2);
  const hasUpdates =
    move.state !== "empty" || headsUps.length > 0 || recentOutcomes.length > 0;
  const chatTarget = move.recommendationId ?? move.actionRunId ?? "move";
  const moveSubtitle = informativeSubtitle(move.summary, move.title);

  return (
    <div style={updatesPopoverStyle}>
      <div style={updatesPopoverHeaderStyle}>
        <Text as="h3" variant="headingSm">
          Store updates
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Live store signals and proposed work. These are separate from the
          current chat.
        </Text>
      </div>
      {headsUps.map((headsUp) => (
        <div key={headsUp.id} style={updateItemStyle}>
          <Mono>Worth knowing</Mono>
          <Text as="p" variant="bodySm">
            {headsUp.text}
          </Text>
        </div>
      ))}
      {recentOutcomes.map((action) => (
        <div key={action.actionRunId} style={updateItemStyle}>
          <Mono>Recent action</Mono>
          <Text as="p" variant="bodySm">
            {outcomeMessageText(action)}
          </Text>
        </div>
      ))}
      {move.state !== "empty" ? (
        <div style={updateItemStyle}>
          <Mono>{move.state === "in_progress" ? "In progress" : "Next move"}</Mono>
          <Text as="h4" variant="headingSm">
            {move.title}
          </Text>
          {moveSubtitle ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {moveSubtitle}
            </Text>
          ) : null}
          <Link
            to={searchWith(currentSearch, { actionChat: chatTarget })}
            style={updateActionLinkStyle}
            onClick={onNavigate}
          >
            Talk this through →
          </Link>
        </div>
      ) : null}
      {!hasUpdates ? (
        <div style={updateItemStyle}>
          <Text as="p" variant="bodySm">
            {quietLine}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

function ConversationMomentAnchor({ anchorId }: { anchorId: string }) {
  return <span id={anchorId} aria-hidden="true" style={momentAnchorStyle} />;
}

// Jefe failing to answer, said in the thread rather than on an error page. This renders in
// Jefe's own message position on purpose: a reply that didn't arrive is Jefe's problem, not
// a fault in what the merchant typed, and it reads as part of the conversation. The retry
// posts `chat.retry`, which answers the message already sitting above it — the merchant
// never retypes, and the thread never ends up holding what they said twice.
function ReplyFailedRow({ conversationId }: { conversationId: string | null }) {
  const navigation = useNavigation();
  const isRetrying =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "chat.retry";
  return (
    <div style={messageRowStyle} aria-live="polite">
      <span style={smallMarkStyle}>J</span>
      <div style={replyFailedBubbleStyle}>
        <span>I couldn&apos;t get to that one just now — your message is saved.</span>
        <Form method="post">
          <input type="hidden" name="intent" value="chat.retry" />
          {conversationId ? (
            <input type="hidden" name="conversationId" value={conversationId} />
          ) : null}
          <button type="submit" style={replyRetryButtonStyle} disabled={isRetrying}>
            {isRetrying ? "Trying again…" : "Try again"}
          </button>
        </Form>
      </div>
    </div>
  );
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

function scrollToMoment(id: string) {
  const el = typeof document === "undefined" ? null : document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
}

function ConversationIndex({ entries }: { entries: IndexEntry[] }) {
  return (
    <nav
      className="jefe-home-index"
      aria-label="Conversation index"
      style={indexRailStyle}
    >
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
// old Action history / Also-in-progress cards used, now rendered in Store updates.
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
  const handleComposerSubmit = () => setComposerMessage("");
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
          <Form
            method="post"
            style={composerStyle}
            onSubmit={handleComposerSubmit}
          >
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
            <button
              type="submit"
              style={sendButtonStateStyle(isThinking)}
              disabled={isThinking}
            >
              Send
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

function StorePrompt({
  message,
  conversationId,
}: {
  message: string;
  conversationId?: string | null;
}) {
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="chat.message" />
      <input type="hidden" name="conversationId" value={conversationId ?? ""} />
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
const summaryStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 16,
  lineHeight: 1.55,
  margin: 0,
  maxWidth: 760,
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
  minHeight: 320,
  padding: "28px 0",
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
// Deliberately NOT an alarm colour. Jefe not getting to a message is a hiccup in a
// conversation, not a store problem — dressing it in red would tell the merchant something
// is wrong with their business.
const replyFailedBubbleStyle: CSSProperties = {
  alignItems: "flex-start",
  color: COLORS.muted,
  display: "flex",
  flexWrap: "wrap",
  fontSize: 15,
  gap: 10,
  lineHeight: 1.6,
  maxWidth: "86%",
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
const momentAnchorStyle: CSSProperties = {
  display: "block",
  height: 0,
  overflow: "hidden",
};
const indexRailStyle: CSSProperties = {
  borderBottom: `1px solid ${COLORS.hairline}`,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "14px 16px",
};
const indexHeadingStyle: CSSProperties = {
  ...monoStyle,
  fontSize: 10,
};
const indexListStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};
const indexEntryStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10,
  color: COLORS.body,
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  fontFamily: FONT.sans,
  gap: 2,
  maxWidth: 220,
  padding: "8px 10px",
  textAlign: "left",
};
const indexEntryLabelStyle: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const indexEntryMetaStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 11,
  fontWeight: 600,
};

const threadControlsStyle: CSSProperties = {
  background: "rgba(255, 253, 250, 0.72)",
  borderBottom: `1px solid ${COLORS.hairline}`,
  borderTop: `1px solid ${COLORS.hairline}`,
  padding: "18px 16px",
};
const threadIdentityStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 180,
};
const emptyChatStyle: CSSProperties = {
  alignItems: "center",
  alignSelf: "center",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  justifyContent: "center",
  margin: "auto 0",
  maxWidth: 430,
  padding: "36px 24px",
  textAlign: "center",
};
const emptyChatMarkStyle: CSSProperties = {
  ...markStyle,
  height: 38,
  marginBottom: 4,
  width: 38,
};
const updatesPopoverStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  maxHeight: 480,
  maxWidth: 380,
  minWidth: 320,
  overflowY: "auto",
  padding: 16,
};
const updatesPopoverHeaderStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  padding: "2px 4px 14px",
};
const updateItemStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.hairline}`,
  display: "flex",
  flexDirection: "column",
  gap: 7,
  padding: "14px 4px",
};
const updateActionLinkStyle: CSSProperties = {
  color: COLORS.navy,
  fontSize: 13.5,
  fontWeight: 700,
  marginTop: 3,
  textDecoration: "none",
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

function sendButtonStateStyle(disabled: boolean): CSSProperties {
  return {
    ...sendButtonStyle,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
  };
}
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
