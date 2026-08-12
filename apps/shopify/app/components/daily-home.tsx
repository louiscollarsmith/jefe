import { Form, Link, useLocation, useNavigation } from "react-router";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { HorizonItem, HorizonWatch } from "./app-home/sections";
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
  checklist: Array<{ label: string; done: boolean }>;
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
}) {
  const location = useLocation();
  const suggestedAction = props.suggestedAction ?? null;
  const actions = props.executedActions ?? [];
  const primaryMove = buildPrimaryMove({
    recommendation: props.recommendation,
    suggestedAction,
    actions,
    goals: props.goals,
  });
  const chatOpen = Boolean(props.actionChatId);

  if (chatOpen) {
    return (
      <ActionChat
        move={primaryMove}
        thread={props.actionChatThread ?? { topic: null, messages: [] }}
        backTo={searchWith(location.search, { actionChat: null })}
      />
    );
  }

  const alsoInProgress = actions.filter(
    (action) =>
      (action.status === "applied" || action.status === "partially_applied") &&
      action.outcome.measured === false &&
      action.actionRunId !== primaryMove.actionRunId,
  );
  const history = actions.filter(
    (action) =>
      action.status === "rejected" ||
      action.status === "reverted" ||
      ((action.status === "applied" || action.status === "partially_applied") &&
        action.outcome.measured === true),
  );
  const watching = buildWatching(props.insights, props.horizonWatching);

  return (
    <main style={pageStyle}>
      <div style={shellStyle}>
        <Header storeName={props.storeName} />
        <h1 style={headlineStyle}>
          {primaryMove.state === "in_progress" ? (
            <>
              Here&apos;s what we&apos;re working <em style={headlineEmStyle}>on.</em>
            </>
          ) : (
            <>
              Here&apos;s what I&apos;d do <em style={headlineEmStyle}>next.</em>
            </>
          )}
        </h1>
        <PrimaryMoveCard move={primaryMove} currentSearch={location.search} />
        <AlsoInProgress actions={alsoInProgress} />
        <ActionHistory actions={history} />
        <WatchingSection items={watching} />
        <GoalsSection goals={props.goals} />
        {/* The door to Merchant Memory — persistent, so it's reachable even when the home is
            all-clear (it previously lived inside WatchingSection, which is hidden when there's
            nothing to watch, making the memory surface unreachable on a quiet store). */}
        <Link to="?view=memory" style={footerLinkStyle}>
          See everything Jefe knows →
        </Link>
      </div>
    </main>
  );
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

function Header({ storeName }: { storeName: string }) {
  return (
    <header style={headerStyle}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={markStyle}>J</span>
        <strong style={{ fontSize: 16 }}>{storeName || "Jefe Store"}</strong>
      </div>
      <DateLabel>{formatToday()}</DateLabel>
    </header>
  );
}

function PrimaryMoveCard({ move, currentSearch }: { move: PrimaryMove; currentSearch: string }) {
  if (move.state === "empty") {
    return (
      <section style={cardStyle}>
        <Mono>ALL CLEAR</Mono>
        <h2 style={cardTitleStyle}>Nothing&apos;s on fire — you&apos;re all clear.</h2>
      </section>
    );
  }

  const chatTarget = move.recommendationId ?? move.actionRunId ?? "move";
  const subtitle = informativeSubtitle(move.summary, move.title);
  return (
    <section style={cardStyle}>
      <div style={cardTopStyle}>
        <Mono>{move.state === "in_progress" ? "IN PROGRESS" : "YOUR NEXT MOVE"}</Mono>
        <StatusPill tone={move.statusTone}>{move.statusLabel}</StatusPill>
      </div>
      <h2 style={cardTitleStyle}>{move.title}</h2>
      {move.state === "proposed" ? (
        <>
          {subtitle ? <p style={summaryStyle}>{subtitle}</p> : null}
          <Link
            to={searchWith(currentSearch, { actionChat: chatTarget })}
            style={primaryButtonStyle}
          >
            Talk this through →
          </Link>
          <WhyThis move={move} />
        </>
      ) : (
        <>
          <div style={moveDetailBlockStyle}>
            <Mono>PROGRESS</Mono>
            <div style={checklistStyle}>
              {move.checklist.map((item) => (
                <span key={item.label} style={checkItemStyle}>
                  <span aria-hidden="true" style={{ color: item.done ? COLORS.green : COLORS.meta }}>
                    {item.done ? "✓" : "○"}
                  </span>
                  {item.label}
                </span>
              ))}
            </div>
          </div>
          {move.successSignal ? (
            <div style={moveDetailBlockStyle}>
              <Mono>WHAT SUCCESS LOOKS LIKE</Mono>
              <p style={summaryStyle}>{move.successSignal}</p>
            </div>
          ) : null}
          {move.baselineSignal || move.currentSignal ? (
            <div style={signalStyle}>
              <span>{move.baselineSignal ?? "Starting point"}</span>
              <span aria-hidden="true">→</span>
              <strong>{move.currentSignal ?? move.baselineSignal}</strong>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function WhyThis({ move }: { move: PrimaryMove }) {
  return (
    <div style={whyStyle}>
      <Mono>WHY THIS</Mono>
      <div style={whyGridStyle}>
        <WhyCell label="3-MONTH GOAL" value={move.successSignal ?? "Move the business goal forward"} />
        <span style={whyArrowStyle}>→</span>
        <WhyCell label="WHAT I'VE LEARNED" value={compactWhyThis(move.whyThisAction || move.whyNow)} />
        <span style={whyArrowStyle}>→</span>
        <WhyCell label="RECOMMENDED MOVE" value={move.title} accent />
      </div>
    </div>
  );
}

function WhyCell({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <Mono>{label}</Mono>
      <div
        title={value}
        style={{
          ...whyValueStyle,
          color: accent ? COLORS.navy : COLORS.ink,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function AlsoInProgress({ actions }: { actions: ExecutedAction[] }) {
  if (!actions.length) return null;
  return (
    <section style={sectionStyle}>
      <h2 style={sectionTitleStyle}>Also in progress</h2>
      {actions.slice(0, 3).map((action) => (
        <div key={action.actionRunId} style={compactCardStyle}>
          <div style={rowTopStyle}>
            <strong>{action.sourceRecommendation?.title || action.headline}</strong>
            <StatusPill tone="green">Approved {formatShortDate(action.appliedAt)}</StatusPill>
          </div>
          <div style={miniChecklistStyle}>
            <span>✓ variants selected</span>
            <span>✓ markdown applied</span>
            <span>○ sell-through observed</span>
          </div>
          {action.baselineSignal || action.currentSignal ? (
            <div style={signalCompactStyle}>
              {action.baselineSignal} <span>→</span> <strong>{action.currentSignal ?? action.baselineSignal}</strong>
            </div>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function ActionHistory({ actions }: { actions: ExecutedAction[] }) {
  if (!actions.length) return null;
  return (
    <section style={sectionStyle}>
      <h2 style={sectionTitleStyle}>Action history</h2>
      <div>
        {actions.slice(0, 6).map((action) => {
          const declined = action.status === "rejected";
          return (
            <div key={action.actionRunId} style={historyRowStyle}>
              <div>
                <strong>{action.sourceRecommendation?.title || action.headline}</strong>
                <p style={historyCopyStyle}>
                  {declined
                    ? action.declineLearning ?? "Jefe learned this was not the right move right now."
                    : action.outcome.measured
                      ? action.outcome.summary ?? "Done."
                      : "Jefe is tracking the result."}
                </p>
              </div>
              <div style={historyMetaStyle}>
                <Mono>{formatShortDate(declined ? action.rejectedAt ?? null : action.appliedAt ?? action.revertedAt)}</Mono>
                <strong style={{ color: declined ? COLORS.meta : COLORS.green }}>
                  {declined ? "declined" : "done"}
                </strong>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function WatchingSection({ items }: { items: Array<{ id: string; title: string; body: string }> }) {
  if (!items.length) return null;
  return (
    <section style={sectionStyle}>
      <h2 style={sectionTitleStyle}>What I&apos;m watching</h2>
      {items.map((item) => (
        <div key={item.id} style={watchRowStyle}>
          <div>
            <strong>{item.title}</strong>
            <p style={historyCopyStyle}>{item.body}</p>
          </div>
          <span style={{ color: COLORS.border }}>→</span>
        </div>
      ))}
    </section>
  );
}

function GoalsSection({ goals }: { goals: Goal[] }) {
  if (!goals.length) return null;
  return (
    <section id="goals" style={sectionStyle}>
      <h2 style={sectionTitleStyle}>Where we&apos;re heading</h2>
      <div style={goalsGridStyle}>
        {goals.slice(0, 3).map((goal) => (
          <div key={goal.id}>
            <Mono>{horizonLabel(goal.horizon)}</Mono>
            <strong style={{ display: "block", marginTop: 8 }}>{goal.title}</strong>
          </div>
        ))}
      </div>
      <a href="#goals" style={footerLinkStyle}>
        View goals →
      </a>
    </section>
  );
}

function ActionChat({
  move,
  thread,
  backTo,
}: {
  move: PrimaryMove;
  thread: ActionChatThread;
  backTo: string;
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
    if (isThinking && pendingMessage) submittedMessageRef.current = pendingMessage;
  }, [isThinking, pendingMessage]);
  useEffect(() => {
    if (!isThinking && submittedMessageRef.current) {
      if (composerMessage.trim() === submittedMessageRef.current) setComposerMessage("");
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
          <DateLabel>{formatToday()}</DateLabel>
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
              onChange={(event) => setComposerMessage(event.currentTarget.value)}
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
      checklist: [],
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
      statusLabel: `Approved ${formatShortDate(inProgress.appliedAt)}`,
      statusTone: "green",
      approvedAt: inProgress.appliedAt,
      baselineSignal: inProgress.baselineSignal ?? null,
      currentSignal: inProgress.currentSignal ?? inProgress.baselineSignal ?? null,
      checklist: [
        { label: "variants selected", done: true },
        { label: "markdown applied", done: true },
        { label: "sell-through observed", done: inProgress.outcome.measured },
      ],
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
    checklist: [],
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

function compactWhyThis(value: string) {
  const firstSentence = value
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)[0]
    ?.trim();
  let compact = firstSentence || value.trim();
  compact = compact
    .replace(/\bbased on trailing sell rates\b\.?/i, "")
    .replace(/\bhold fewer than 21 days of stock cover\b/i, "have fewer than 21 days of stock")
    .replace(/\bTwo\b/g, "2")
    .replace(/\btwo\b/g, "2")
    .replace(/\s+/g, " ")
    .trim();
  return compact;
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

function buildWatching(insights: Insight[], horizonWatching: HorizonWatch[]) {
  const fromInsights = (insights || []).map((insight) => ({
    id: `insight-${insight.id}`,
    title: insight.title,
    body: insight.finding,
  }));
  const fromHorizon = (horizonWatching || []).map((item) => ({
    id: `horizon-${item.id}`,
    title: item.title,
    body: item.reason,
  }));
  // Reserve at least one slot for Horizon when it has items, so a store with ≥3
  // insights can't silently starve it — both are "watching, not acting" signals and
  // neither should win purely by concatenation order.
  const reservedForHorizon = Math.min(fromHorizon.length, 1);
  return [...fromInsights.slice(0, 3 - reservedForHorizon), ...fromHorizon].slice(0, 3);
}

function horizonLabel(horizon: string) {
  if (horizon === "threeMonths") return "3 MONTHS";
  if (horizon === "sixMonths") return "6 MONTHS";
  if (horizon === "twelveMonths") return "12 MONTHS";
  return horizon.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
}

// SSR runs in UTC (Railway); the browser runs in the merchant's local zone. With no
// timeZone pinned, toLocaleDateString formats a DIFFERENT calendar date on each side for
// the 00:00–01:00 London window every day, so React discards the whole server render as a
// hydration mismatch (#418/#425) — the bug behind the wrong "Tuesday 11 August" header.
// Pin ONE named zone so both sides render identical text (house rule: one constant, never
// a scattered literal). TODO(jefe, task #13): source this from the merchant's shop
// ianaTimezone (already loaded at app._index) so a non-UK store reads its own date; safe
// to do once the home surface settles, as it threads a prop through the header path.
const VIEWER_TIME_ZONE = "Europe/London";

function formatToday() {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    timeZone: VIEWER_TIME_ZONE,
  });
}

function formatShortDate(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: VIEWER_TIME_ZONE,
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
const smallMarkStyle: CSSProperties = { ...markStyle, width: 22, height: 22, borderRadius: 6, fontSize: 12, flex: "none" };
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
const cardTitleStyle: CSSProperties = {
  fontFamily: FONT.serif,
  fontSize: 27,
  lineHeight: 1.28,
  margin: 0,
  fontWeight: 500,
  letterSpacing: 0,
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
const whyStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.hairline}`,
  paddingTop: 22,
};
const whyGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 18px minmax(0, 1fr) 18px minmax(0, 1fr)",
  columnGap: 12,
  alignItems: "start",
  marginTop: 14,
};
const whyArrowStyle: CSSProperties = {
  alignSelf: "start",
  color: COLORS.border,
  fontSize: 18,
  lineHeight: 1,
  paddingTop: 26,
  textAlign: "center",
};
const whyValueStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.35,
  marginTop: 6,
  overflowWrap: "break-word",
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
const moveDetailBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
};
const checklistStyle: CSSProperties = {
  display: "flex",
  gap: 18,
  flexWrap: "wrap",
  color: COLORS.body,
};
const checkItemStyle: CSSProperties = {
  alignItems: "center",
  display: "inline-flex",
  gap: 7,
  fontSize: 14.5,
};
const signalStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  flexWrap: "wrap",
  color: COLORS.meta,
  fontSize: 14.5,
};
const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
};
const sectionTitleStyle: CSSProperties = {
  fontFamily: FONT.serif,
  fontSize: 19,
  lineHeight: 1.15,
  fontWeight: 500,
  margin: 0,
};
const compactCardStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 12,
  fontSize: 14.5,
  padding: "18px 20px",
};
const rowTopStyle: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 20,
  alignItems: "center",
  fontSize: 14.5,
};
const miniChecklistStyle: CSSProperties = {
  display: "flex",
  gap: 18,
  flexWrap: "wrap",
  color: COLORS.body,
  fontSize: 14.5,
  marginTop: 14,
};
const signalCompactStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 14.5,
  marginTop: 12,
};
const historyRowStyle: CSSProperties = {
  alignItems: "flex-start",
  borderBottom: `1px solid ${COLORS.hairline}`,
  display: "flex",
  justifyContent: "space-between",
  gap: 24,
  fontSize: 14.5,
  padding: "17px 0 18px",
};
const historyCopyStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 14.5,
  lineHeight: 1.4,
  margin: "4px 0 0",
};
const historyMetaStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "none",
  gap: 12,
  fontSize: 12,
};
const watchRowStyle: CSSProperties = {
  alignItems: "center",
  borderBottom: `1px solid ${COLORS.hairline}`,
  display: "flex",
  justifyContent: "space-between",
  gap: 20,
  fontSize: 14.5,
  padding: "16px 0 17px",
};
const footerLinkStyle: CSSProperties = {
  color: COLORS.navy,
  display: "block",
  fontSize: 14.5,
  fontWeight: 700,
  textAlign: "right",
  textDecoration: "none",
};
const goalsGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: 32,
  fontSize: 14.5,
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
