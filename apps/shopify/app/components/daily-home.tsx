import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useLocation,
  useNavigation,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, CSSProperties, ReactNode } from "react";
import {
  Button,
  Text,
} from "@shopify/polaris";
import type { HorizonItem, HorizonWatch } from "./app-home/sections";
import {
  ChatTurnReporter,
  markApprovalSent,
  markChatTurnSent,
} from "./chat-turn-reporter";
import {
  ATTACHMENT_ACCEPT,
  attachmentRejectionReason,
} from "../lib/attachments/attachment-limits.js";
import { formatDateInZone } from "../lib/home/home-dates.js";
import type {
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
  messageCount?: number | null;
  focusedActionId?: string | null;
  focusedAction?: {
    id: string;
    title: string;
    summary?: string | null;
    status?: string | null;
    sourceRecommendationId?: string | null;
    actionRunId?: string | null;
  } | null;
};
type ChatThread = {
  conversation: ChatConversation | null;
  conversations: ChatConversation[];
  messages: Array<{
    id: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown> | null;
  }>;
};
type ChatRenameActionData = {
  ok?: boolean;
  intent?: string;
  conversationId?: string;
  title?: string | null;
  error?: string;
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
  // Why Jefe is leaving this one to the merchant. Null when there is nothing specific to
  // say — the surface falls back to its own line rather than inventing a cause.
  raise: { reason: string; detail: string | null } | null;
  state: "proposed" | "in_progress" | "empty";
  statusLabel: string;
  statusTone: "yellow" | "green";
  approvedAt: string | null;
  baselineSignal: string | null;
  currentSignal: string | null;
};

type MerchantActionView = {
  id: string;
  title: string;
  summary?: string | null;
  status: string;
  statusLabel?: string | null;
  statusTone?: string | null;
  sourceRecommendationId?: string | null;
  actionRunId?: string | null;
  actionType?: string | null;
  executable?: boolean;
  raise?: { reason: string; detail: string | null } | null;
  progress?: Record<string, unknown> | null;
  displaySteps?: Array<string | { label?: string | null }>;
  successText?: string | null;
  baselineSignal?: string | null;
  currentSignal?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
};

type FocusedActionChatChoice = {
  id: string;
  title: string;
  messageCount?: number | null;
  lastMessageAt?: string | null;
  createdAt?: string | null;
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
  merchantActions?: MerchantActionView[];
  talkActionId?: string | null;
  focusedActionChats?: FocusedActionChatChoice[];
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
  const executedActions = props.executedActions ?? [];
  const primaryMove = buildPrimaryMove({
    recommendation: props.recommendation,
    suggestedAction,
    actions: executedActions,
    goals: props.goals,
    storeTimeZone: props.storeTimeZone,
  });
  const fallbackAction = merchantActionFromPrimaryMove(primaryMove);
  const merchantActions =
    props.merchantActions && props.merchantActions.length > 0
      ? props.merchantActions
      : fallbackAction
        ? [fallbackAction]
        : [];
  const activeConversation = props.conversation?.conversation ?? null;
  const openConversationId = new URLSearchParams(location.search).get(
    "conversation",
  );
  const focusedAction = actionForConversation(activeConversation, merchantActions);

  if (openConversationId || activeConversation) {
    return (
      <FocusedConversation
        conversation={props.conversation ?? null}
        focusedAction={focusedAction}
        merchantActions={merchantActions}
        currentSearch={location.search}
        todayLabel={props.todayLabel}
      />
    );
  }

  return (
    <main style={pageStyle}>
      <div style={shellStyle}>
        <Header
          storeName={props.storeName}
          todayLabel={props.todayLabel}
          brandLogoUrl={props.brandLogoUrl}
        />
        <FocusedActionsHome
          conversations={props.conversation?.conversations ?? []}
          merchantActions={merchantActions}
          talkActionId={props.talkActionId ?? null}
          focusedActionChats={props.focusedActionChats ?? []}
          currentSearch={location.search}
          storeTimeZone={props.storeTimeZone}
        />
        {/* No footer link. Merchant Memory is reached from the shell gear →
            Settings → "What Jefe knows" (see surface-reachability tests);
            the chat log itself stays clean. */}
      </div>
    </main>
  );
}

function FocusedActionsHome({
  conversations,
  merchantActions,
  talkActionId,
  focusedActionChats,
  currentSearch,
  storeTimeZone,
}: {
  conversations: ChatConversation[];
  merchantActions: MerchantActionView[];
  talkActionId: string | null;
  focusedActionChats: FocusedActionChatChoice[];
  currentSearch: string;
  storeTimeZone?: string | null;
}) {
  const nextAction = pickNextAction(merchantActions);
  const inProgress = merchantActions.filter(isWorkingAction);
  const history = merchantActions.filter(isHistoricalAction);
  const talkAction = talkActionId
    ? merchantActions.find((action) => action.id === talkActionId) ?? null
    : null;

  return (
    <>
      <section style={homeHeroStyle} aria-label="Your next move">
        <h1 style={headlineStyle}>
          Here&apos;s what I&apos;d do <em style={headlineEmStyle}>next.</em>
        </h1>
        <ActionSpotlight action={nextAction} />
      </section>

      <HomeSection
        title="Chats"
        action={
          <Form method="post" style={inlineFormStyle}>
            <input type="hidden" name="intent" value="chat.new" />
            <button type="submit" style={pillButtonStyle}>
              + New chat
            </button>
          </Form>
        }
      >
        {conversations.length > 0 ? (
          <div style={chatListStyle}>
            {conversations.slice(0, 8).map((conversation) => (
              <Link
                key={conversation.id}
                to={searchWith(currentSearch, {
                  conversation: conversation.id,
                  talkAction: null,
                })}
                style={chatListItemStyle}
              >
                <span style={chatListBodyStyle}>
                  <span style={chatListTitleStyle}>
                    {conversationTitle(conversation)}
                  </span>
                  <span style={chatListMetaLineStyle}>
                    {conversation.focusedAction ? (
                      <span style={chatFocusMetaStyle}>
                        <span style={boltStyle}>⚡</span>
                        <strong style={chatFocusLeadStyle}>Working on</strong>
                        {conversation.focusedAction.title}
                      </span>
                    ) : null}
                    <span>{messageCountLabel(conversation.messageCount)}</span>
                  </span>
                </span>
                <span style={chatListDateStyle}>
                  {formatConversationDate(
                    conversation.lastMessageAt,
                    storeTimeZone,
                  )}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <EmptySection
            title="No chats yet"
            body="Start with a blank chat, or talk through the next action when Jefe has one."
          />
        )}
      </HomeSection>

      <ActionShelf
        title="In Progress Actions"
        emptyTitle="Nothing in progress"
        emptyBody="When an action is approved or being executed, it will stay here until Jefe can report the outcome."
        actions={inProgress}
        currentSearch={currentSearch}
        variant="progress"
      />

      <ActionShelf
        title="Action history"
        emptyTitle="No action history yet"
        emptyBody="Completed, declined, deferred and superseded actions will appear here."
        actions={history}
        currentSearch={currentSearch}
        variant="history"
      />

      <TalkActionChooser
        action={talkAction}
        chats={focusedActionChats}
        currentSearch={currentSearch}
        storeTimeZone={storeTimeZone}
      />
    </>
  );
}

function ActionSpotlight({ action }: { action: MerchantActionView | null }) {
  if (!action) {
    return (
      <section style={spotlightStyle}>
        <Mono>YOUR NEXT MOVE</Mono>
        <h2 style={spotlightTitleStyle}>Jefe does not have a next move yet.</h2>
        <p style={summaryStyle}>
          When there is a grounded action to review or execute, it will appear
          here with its own durable chat thread.
        </p>
      </section>
    );
  }

  return (
    <section style={spotlightStyle}>
      <Mono>YOUR NEXT MOVE</Mono>
      <h2 style={spotlightTitleStyle}>{action.title}</h2>
      {action.summary ? <p style={summaryStyle}>{action.summary}</p> : null}
      <div style={actionButtonRowStyle}>
        <TalkThisThroughButton action={action} primary />
      </div>
    </section>
  );
}

function ActionShelf({
  title,
  emptyTitle,
  emptyBody,
  actions,
  currentSearch,
  variant,
}: {
  title: string;
  emptyTitle: string;
  emptyBody: string;
  actions: MerchantActionView[];
  currentSearch: string;
  variant: "progress" | "history";
}) {
  return (
    <HomeSection title={title}>
      {actions.length > 0 ? (
        <div style={actionListStyle}>
          {actions.slice(0, 6).map((action) => (
            variant === "history" ? (
              <ActionHistoryRow
                key={action.id || action.title}
                action={action}
                currentSearch={currentSearch}
              />
            ) : (
              <ActionProgressRow
                key={action.id || action.title}
                action={action}
              />
            )
          ))}
        </div>
      ) : (
        <EmptySection title={emptyTitle} body={emptyBody} />
      )}
    </HomeSection>
  );
}

function ActionProgressRow({ action }: { action: MerchantActionView }) {
  return (
    <article style={progressRowStyle}>
      <div style={progressRowHeaderStyle}>
        <span style={progressRowTitleStyle}>{action.title}</span>
        <StatusPill tone="green">
          {action.statusLabel || statusLabelForAction(action.status)}
        </StatusPill>
      </div>
      {action.summary ? (
        <p style={actionCardSummaryStyle}>{compactText(action.summary, 180)}</p>
      ) : null}
      {action.displaySteps && action.displaySteps.length > 0 ? (
        <div style={stepInlineListStyle}>
          {action.displaySteps.slice(0, 3).map((step, index) => (
            <span
              key={`${displayStepLabel(step, index)}-${index}`}
              style={stepInlineItemStyle}
            >
              <span style={stepGlyphStyle}>{index === 0 ? "✓" : "·"}</span>
              {displayStepLabel(step, index)}
            </span>
          ))}
        </div>
      ) : null}
      <div style={progressRowFooterStyle}>
        <div style={signalLineStyle}>
          {action.baselineSignal ? <span>{action.baselineSignal}</span> : null}
          {action.baselineSignal && action.currentSignal ? <span>→</span> : null}
          {action.currentSignal ? <strong>{action.currentSignal}</strong> : null}
        </div>
        <TalkThisThroughButton action={action} linkLike />
      </div>
    </article>
  );
}

function ActionHistoryRow({
  action,
  currentSearch,
}: {
  action: MerchantActionView;
  currentSearch: string;
}) {
  return (
    <Link
      to={searchWith(currentSearch, {
        talkAction: action.id || null,
      })}
      style={historyRowStyle}
    >
      <span style={chatListBodyStyle}>
        <span style={chatListTitleStyle}>{action.title}</span>
        <span style={historyOutcomeStyle}>
          {action.summary || statusLabelForAction(action.status)}
        </span>
      </span>
      <span style={historyStatusGroupStyle}>
        <span style={chatListDateStyle}>
          {formatConversationDate(action.updatedAt ?? action.createdAt ?? "")}
        </span>
        <span style={historyStatusStyle}>
          {statusLabelForAction(action.status)}
        </span>
      </span>
    </Link>
  );
}
function HomeSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section style={homeSectionStyle}>
      <div style={homeSectionHeaderStyle}>
        <h2 style={sectionTitleStyle}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function EmptySection({ title, body }: { title: string; body: string }) {
  return (
    <div style={emptySectionStyle}>
      <Text as="h3" variant="headingSm">
        {title}
      </Text>
      <Text as="p" variant="bodySm" tone="subdued">
        {body}
      </Text>
    </div>
  );
}

function TalkThisThroughButton({
  action,
  primary = false,
  linkLike = false,
}: {
  action: MerchantActionView;
  primary?: boolean;
  linkLike?: boolean;
}) {
  return (
    <Form method="post" style={inlineFormStyle}>
      <input type="hidden" name="intent" value="chat.focus.start" />
      <input type="hidden" name="focusedActionId" value={action.id} />
      <button
        type="submit"
        style={linkLike ? textButtonStyle : primary ? primaryButtonStyle : quietPillButtonStyle}
        disabled={!action.id}
      >
        Talk this through{primary || linkLike ? " →" : ""}
      </button>
    </Form>
  );
}

function TalkActionChooser({
  action,
  chats,
  currentSearch,
  storeTimeZone,
}: {
  action: MerchantActionView | null;
  chats: FocusedActionChatChoice[];
  currentSearch: string;
  storeTimeZone?: string | null;
}) {
  if (!action) return null;
  return (
    <div style={modalBackdropStyle} role="presentation">
      <section
        style={talkChooserModalStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="talk-action-title"
      >
        <Mono>TALK THIS THROUGH</Mono>
        <p id="talk-action-title" style={talkChooserLeadStyle}>
          {chats.length > 0 ? (
            <>
              You already have a chat working on{" "}
              <strong style={talkChooserStrongStyle}>{action.title}</strong>.
              Continue one, or start a new chat focused on this action.
            </>
          ) : (
            <>
              Start a new chat focused on{" "}
              <strong style={talkChooserStrongStyle}>{action.title}</strong>.
            </>
          )}
        </p>
        {chats.length > 0 ? (
          <div style={talkChooserListStyle}>
            {chats.map((chat) => (
              <Link
                key={chat.id}
                to={searchWith(currentSearch, {
                  conversation: chat.id,
                  talkAction: null,
                })}
                style={talkChooserCardStyle}
              >
                <span style={talkChooserCardTitleStyle}>{chat.title}</span>
                <span style={talkChooserCardMetaStyle}>
                  {messageCountLabel(chat.messageCount)}
                  {" · "}
                  {formatConversationDate(
                    chat.lastMessageAt ?? chat.createdAt ?? "",
                    storeTimeZone,
                  )}
                </span>
              </Link>
            ))}
          </div>
        ) : (
          <EmptySection
            title="No chats for this action yet"
            body="Start a new focused chat to talk through this action."
          />
        )}
        <div style={talkChooserDividerStyle} />
        <div style={talkChooserActionsStyle}>
          <Form method="post" style={inlineFormStyle}>
            <input type="hidden" name="intent" value="chat.focus.start" />
            <input type="hidden" name="focusedActionId" value={action.id} />
            <input type="hidden" name="forceNew" value="true" />
            <button type="submit" style={talkChooserPrimaryButtonStyle}>
              Start a new chat
            </button>
          </Form>
          <Link
            to={searchWith(currentSearch, { talkAction: null })}
            style={talkChooserCancelStyle}
          >
            Cancel
          </Link>
        </div>
      </section>
    </div>
  );
}

function FocusedConversation({
  conversation,
  focusedAction,
  merchantActions,
  currentSearch,
  todayLabel,
}: {
  conversation: ChatThread | null;
  focusedAction: MerchantActionView | null;
  merchantActions: MerchantActionView[];
  currentSearch: string;
  todayLabel?: string;
}) {
  const navigation = useNavigation();
  usePreserveChatScrollDuringIntent(navigation, "chat.message");
  usePreserveChatScrollDuringIntent(navigation, "chat.retry");
  const pendingIntent = navigation.formData?.get("intent");
  const isSending =
    navigation.state !== "idle" && pendingIntent === "chat.message";
  const isRetrying =
    navigation.state !== "idle" && pendingIntent === "chat.retry";
  const isThinking = isSending || isRetrying;
  const pendingMessage =
    isSending && typeof navigation.formData?.get("message") === "string"
      ? String(navigation.formData.get("message")).trim()
      : "";
  // An upload is slow enough that the merchant needs to see their file was taken.
  const pendingUpload = isSending ? navigation.formData?.get("attachment") : null;
  const pendingAttachmentName =
    pendingUpload && typeof pendingUpload !== "string" && pendingUpload.size
      ? pendingUpload.name
      : null;
  const [composerMessage, setComposerMessage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [focusExpanded, setFocusExpanded] = useState(false);
  const [pendingFocus, setPendingFocus] = useState<MerchantActionView | null>(
    null,
  );
  const activeConversation = conversation?.conversation ?? null;
  const messages = conversation?.messages ?? [];
  const lastMessage = messages[messages.length - 1];
  const awaitingReply =
    !isThinking &&
    !pendingMessage &&
    (lastMessage?.role === "merchant" || lastMessage?.role === "user");
  const isBlankThread = messages.length === 0;
  const transcriptRef = useScrollTranscriptToLatest(
    activeConversation?.id ?? null,
    messages.length,
  );
  // A merchant sending Jefe a photo of a shelf or a supplier invoice. The file is read and
  // dropped (derive-and-discard, per the voice-note precedent) — nothing is stored, so this is a
  // way of TELLING Jefe something, not a file library.
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  // A rejection from the server (an unreadable PDF, a provider that failed) — otherwise the
  // attachment would vanish and Jefe would look like it had ignored them.
  const actionData = useActionData() as
    | { ok?: boolean; error?: string; kind?: string; intent?: string }
    | undefined;
  const serverAttachmentError =
    actionData?.ok === false && actionData?.kind === "attachment"
      ? (actionData.error ?? null)
      : null;
  const composerError = attachmentError ?? serverAttachmentError;

  const clearAttachment = () => {
    setAttachedFile(null);
    setAttachmentError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleFileChosen = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    if (!file) {
      clearAttachment();
      return;
    }
    // Refused here as well as on the server, from the same rule set — a file the server would
    // bounce should never cost the merchant an upload.
    const reason = attachmentRejectionReason({
      mimeType: file.type,
      byteLength: file.size,
      filename: file.name,
    });
    if (reason) {
      setAttachedFile(null);
      setAttachmentError(reason);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setAttachedFile(file);
    setAttachmentError(null);
  };

  const handleComposerSubmit = () => {
    markChatTurnSent();
    setComposerMessage("");
    setAttachedFile(null);
    setAttachmentError(null);
    // Deferred deliberately. React Router serialises the form DURING this same submit event, so
    // clearing the input now would send an empty part and silently drop the merchant's file —
    // while never clearing it would re-send that file with their next message.
    setTimeout(() => {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }, 0);
  };

  if (!activeConversation) {
    return (
      <main style={chatPageStyle}>
        <div style={chatShellStyle}>
          <div style={chatTopStyle}>
            <Link
              to={searchWith(currentSearch, { conversation: null })}
              style={backLinkStyle}
            >
              ← Back
            </Link>
            <DateLabel>{todayLabel ?? ""}</DateLabel>
          </div>
          <EmptySection
            title="That chat is not available"
            body="Go back to the home screen and open an active chat."
          />
        </div>
      </main>
    );
  }

  return (
    <main style={chatPageStyle}>
      <div style={chatShellStyle}>
        <ChatTurnReporter
          lastMessageId={lastMessage?.id ?? null}
          lastMessageRole={lastMessage?.role ?? null}
        />
        <div style={chatTopStyle}>
          <Link
            to={searchWith(currentSearch, { conversation: null })}
            style={backLinkStyle}
          >
            ← Back
          </Link>
          <DateLabel>{todayLabel ?? ""}</DateLabel>
        </div>

        <ChatTitleBlock conversation={activeConversation} />

        {focusedAction ? (
          <FocusedActionStrip
            focusedAction={focusedAction}
            focusExpanded={focusExpanded}
            onToggle={() => setFocusExpanded(!focusExpanded)}
          />
        ) : null}

        <div ref={transcriptRef} style={messagesStyle}>
          {isBlankThread && !pendingMessage ? <EmptyChat /> : null}
          {messages.map((message) => (
            <FocusedMessageRow key={message.id} message={message} />
          ))}
          {pendingMessage ? (
            <MessageRow from="merchant">{pendingMessage}</MessageRow>
          ) : null}
          {pendingAttachmentName ? (
            <MessageRow from="merchant">{`[Attached: ${pendingAttachmentName}]`}</MessageRow>
          ) : null}
          {isThinking ? (
            <div style={messageRowStyle} aria-live="polite">
              <span style={smallMarkStyle}>J</span>
              {/* Reading a file takes visibly longer than answering — say which wait it is. */}
              <div style={thinkingStyle}>
                {pendingAttachmentName ? "Reading your file" : "Thinking"}
              </div>
            </div>
          ) : null}
          {awaitingReply ? (
            <ReplyFailedRow conversationId={activeConversation.id} />
          ) : null}
        </div>

        <div style={chatComposerWrapStyle}>
          {menuOpen ? (
            <div style={attachMenuPanelStyle}>
              <div style={attachMenuHeaderStyle}>
                <Mono>BRING AN ACTION INTO THIS CHAT</Mono>
                <button
                  type="button"
                  style={attachMenuCloseStyle}
                  onClick={() => setMenuOpen(false)}
                >
                  Close
                </button>
              </div>
              <ActionAttachmentMenu
                conversationId={activeConversation.id}
                currentFocusedActionId={focusedAction?.id ?? null}
                actions={merchantActions}
                onRequestFocusChange={(action) => {
                  setMenuOpen(false);
                  setPendingFocus(action);
                }}
              />
            </div>
          ) : null}
          {composerError ? (
            <div style={composerErrorStyle} role="status">
              {composerError}
            </div>
          ) : null}
          {attachedFile ? (
            <div style={attachedFileRowStyle}>
              <span style={attachedFileNameStyle}>{attachedFile.name}</span>
              <button
                type="button"
                style={attachedFileRemoveStyle}
                onClick={clearAttachment}
                disabled={isThinking}
              >
                Remove
              </button>
            </div>
          ) : null}
          <Form
            method="post"
            preventScrollReset
            // Only when there is a file: a plain message has no reason to pay for multipart.
            encType={attachedFile ? "multipart/form-data" : undefined}
            style={composerStyle}
            onSubmit={handleComposerSubmit}
          >
            <input type="hidden" name="intent" value="chat.message" />
            <input
              type="hidden"
              name="conversationId"
              value={activeConversation.id}
            />
            <button
              type="button"
              aria-label="Bring in an action"
              style={attachButtonStyle(menuOpen)}
              onClick={() => setMenuOpen(!menuOpen)}
              disabled={isThinking}
            >
              +
            </button>
            <input
              ref={fileInputRef}
              type="file"
              name="attachment"
              accept={ATTACHMENT_ACCEPT}
              onChange={handleFileChosen}
              style={hiddenFileInputStyle}
              tabIndex={-1}
            />
            <button
              type="button"
              aria-label="Send Jefe a photo, PDF or CSV"
              title="Send Jefe a photo, PDF or CSV"
              style={attachButtonStyle(Boolean(attachedFile))}
              onClick={() => fileInputRef.current?.click()}
              disabled={isThinking}
            >
              {/* Inline rather than a glyph: a paperclip emoji keeps its own colour and would
                  stay yellow on the navy active state. currentColor follows the button. */}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            {focusedAction?.id ? (
              <input
                type="hidden"
                name="focusedActionId"
                value={focusedAction.id}
              />
            ) : null}
            <input
              name="message"
              // A file on its own is a complete message — "here, look at this".
              required={!attachedFile}
              autoComplete="off"
              aria-label="Message Jefe"
              placeholder={
                attachedFile
                  ? "Say something about this file, or just send it..."
                  : focusedAction
                    ? "Ask about this action, or tell me what to change..."
                    : "Ask Jefe anything, or pick an action to work on..."
              }
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
          <FocusedActionDecisionRow action={focusedAction} />
        </div>

        <FocusChangeConfirm
          conversationId={activeConversation.id}
          action={pendingFocus}
          onCancel={() => setPendingFocus(null)}
        />
      </div>
    </main>
  );
}

function ChatTitleBlock({
  conversation,
}: {
  conversation: ChatConversation;
}) {
  const renameFetcher = useFetcher<ChatRenameActionData>();
  const renameData = renameFetcher.data;
  const saving = renameFetcher.state !== "idle";
  const fetchedTitle =
    renameData?.intent === "chat.rename" &&
    renameData.ok &&
    renameData.conversationId === conversation.id
      ? renameData.title
      : undefined;
  const displayTitle =
    fetchedTitle === undefined
      ? conversationTitle(conversation)
      : fetchedTitle || "New chat";

  const finishTitleEdit = (nextTitle: string) => {
    if (nextTitle.trim() === displayTitle.trim()) return;
    const formData = new FormData();
    formData.set("intent", "chat.rename");
    formData.set("conversationId", conversation.id);
    formData.set("title", nextTitle);
    renameFetcher.submit(formData, { method: "post" });
  };

  return (
    <section style={chatTitleBlockStyle}>
      <Mono>CHAT</Mono>
      <ChatTitleInlineEditor
        key={`${conversation.id}:${displayTitle}`}
        title={displayTitle}
        saving={saving}
        onCommit={finishTitleEdit}
      />
    </section>
  );
}

function ChatTitleInlineEditor({
  title,
  saving,
  onCommit,
}: {
  title: string;
  saving: boolean;
  onCommit: (title: string) => void;
}) {
  const [draftTitle, setDraftTitle] = useState(title);
  const cancelTitleBlurRef = useRef(false);
  const [titleHovered, setTitleHovered] = useState(false);
  const [titleFocused, setTitleFocused] = useState(false);
  const titleInputActive = titleHovered || titleFocused;
  const cancelInlineTitleEdit = () => {
    cancelTitleBlurRef.current = true;
    setDraftTitle(title);
  };
  const finishInlineTitleEdit = (nextTitle: string) => {
    if (cancelTitleBlurRef.current) {
      cancelTitleBlurRef.current = false;
      return;
    }
    onCommit(nextTitle);
  };

  return (
    <input
      name="title"
      value={draftTitle}
      onChange={(event) => setDraftTitle(event.currentTarget.value)}
      onMouseEnter={() => setTitleHovered(true)}
      onMouseLeave={() => setTitleHovered(false)}
      onFocus={() => setTitleFocused(true)}
      onBlur={(event) => {
        setTitleFocused(false);
        finishInlineTitleEdit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancelInlineTitleEdit();
          event.currentTarget.blur();
        }
      }}
      disabled={saving}
      aria-label="Chat name"
      autoComplete="off"
      style={chatTitleInlineInputStyle(titleInputActive)}
    />
  );
}

function FocusedActionStrip({
  focusedAction,
  focusExpanded,
  onToggle,
}: {
  focusedAction: MerchantActionView;
  focusExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <section style={focusStripWrapStyle} aria-label="Working on">
      <div style={focusPanelStyle}>
        <button
          type="button"
          style={focusStripButtonStyle}
          onClick={onToggle}
          aria-expanded={focusExpanded}
        >
          <span style={focusStripLeftStyle}>
            <span style={boltStyle}>⚡</span>
            <span style={focusStripTextStyle}>
              <span style={focusStripLabelStyle}>WORKING ON</span>
              <span style={focusStripTitleStyle}>{focusedAction.title}</span>
            </span>
          </span>
          <span style={focusStripRightStyle}>
            <span style={focusStatusStyle(focusedAction.status)}>
              {focusedAction.statusLabel ||
                statusLabelForAction(focusedAction.status)}
            </span>
            <span style={focusStripChevronStyle}>
              {focusExpanded ? "▲" : "▼"}
            </span>
          </span>
        </button>
        {focusExpanded ? (
          <div style={focusDetailStyle}>
            {focusedAction.summary ? (
              <p style={focusDetailSummaryStyle}>
                {compactText(focusedAction.summary, 320)}
              </p>
            ) : null}
            {focusedAction.displaySteps && focusedAction.displaySteps.length > 0 ? (
              <div style={stepInlineListStyle}>
                {focusedAction.displaySteps.slice(0, 3).map((step, index) => (
                  <span
                    key={`${displayStepLabel(step, index)}-${index}`}
                    style={stepInlineItemStyle}
                  >
                    <span style={stepGlyphStyle}>{index === 0 ? "✓" : "·"}</span>
                    {displayStepLabel(step, index)}
                  </span>
                ))}
              </div>
            ) : null}
            {focusedAction.currentSignal || focusedAction.baselineSignal ? (
              <div style={focusSignalStyle}>
                {focusedAction.currentSignal || focusedAction.baselineSignal}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ActionAttachmentMenu({
  conversationId,
  currentFocusedActionId,
  actions,
  onRequestFocusChange,
}: {
  conversationId: string;
  currentFocusedActionId: string | null;
  actions: MerchantActionView[];
  onRequestFocusChange: (action: MerchantActionView) => void;
}) {
  const available = actions.filter((action) => action.id);
  const workActions = available.filter(
    (action) => action.id !== currentFocusedActionId,
  );
  const referenceActions = available.filter(
    (action) => action.id !== currentFocusedActionId,
  );
  return (
    <div style={actionMenuStyle}>
      <div style={actionMenuGroupStyle}>
        <Text as="h3" variant="headingSm">
          Work on an action
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Make one action the focus of this chat. Jefe can update that action by
          default.
        </Text>
        {workActions.length > 0 ? (
          workActions.slice(0, 8).map((action) =>
            currentFocusedActionId ? (
              <button
                key={action.id}
                type="button"
                style={actionMenuButtonStyle}
                onClick={() => onRequestFocusChange(action)}
              >
                <span>{action.title}</span>
                <small>{statusLabelForAction(action.status)}</small>
              </button>
            ) : (
              <Form key={action.id} method="post" style={inlineFormStyle}>
                <input type="hidden" name="intent" value="chat.focus.change" />
                <input
                  type="hidden"
                  name="conversationId"
                  value={conversationId}
                />
                <input
                  type="hidden"
                  name="focusedActionId"
                  value={action.id}
                />
                <button type="submit" style={actionMenuButtonStyle}>
                  <span>{action.title}</span>
                  <small>{statusLabelForAction(action.status)}</small>
                </button>
              </Form>
            ),
          )
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            No other actions are available.
          </Text>
        )}
      </div>
      <div style={actionMenuGroupStyle}>
        <Text as="h3" variant="headingSm">
          Reference an action
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          Add read-only context without changing what this chat is working on.
        </Text>
        {referenceActions.length > 0 ? (
          referenceActions.slice(0, 8).map((action) => (
            <Form key={action.id} method="post" style={inlineFormStyle}>
              <input type="hidden" name="intent" value="chat.action.reference" />
              <input
                type="hidden"
                name="conversationId"
                value={conversationId}
              />
              <input
                type="hidden"
                name="referencedActionId"
                value={action.id}
              />
              <button type="submit" style={actionMenuButtonStyle}>
                <span>{action.title}</span>
                <small>Read-only context</small>
              </button>
            </Form>
          ))
        ) : (
          <Text as="p" variant="bodySm" tone="subdued">
            No other actions are available.
          </Text>
        )}
      </div>
    </div>
  );
}

function FocusChangeConfirm({
  conversationId,
  action,
  onCancel,
}: {
  conversationId: string;
  action: MerchantActionView | null;
  onCancel: () => void;
}) {
  if (!action) return null;
  return (
    <div style={modalBackdropStyle} role="presentation">
      <section
        style={chooserModalStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="focus-change-title"
      >
        <div style={modalHeaderStyle}>
          <div>
            <Mono>CHANGE FOCUS</Mono>
            <h2 id="focus-change-title" style={modalTitleStyle}>
              Work on {action.title}?
            </h2>
          </div>
          <button
            type="button"
            style={modalCloseButtonStyle}
            onClick={onCancel}
            aria-label="Cancel focus change"
          >
            ×
          </button>
        </div>
        <p style={summaryStyle}>
          Jefe will treat this as the only action this chat can update by
          default. Other referenced actions stay read-only context.
        </p>
        <div style={modalActionsStyle}>
          <Form method="post" style={inlineFormStyle} onSubmit={onCancel}>
            <input type="hidden" name="intent" value="chat.focus.change" />
            <input type="hidden" name="conversationId" value={conversationId} />
            <input type="hidden" name="focusedActionId" value={action.id} />
            <Button submit variant="primary">
              Switch action
            </Button>
          </Form>
          <Button onClick={onCancel}>Cancel</Button>
        </div>
      </section>
    </div>
  );
}

function FocusedMessageRow({
  message,
}: {
  message: {
    id: string;
    role: string;
    content: string;
    metadata?: Record<string, unknown> | null;
  };
}) {
  if (message.role === "system") {
    return (
      <div style={systemEventStyle}>
        <span style={systemEventLineStyle} />
        <span style={systemEventTextStyle}>{message.content}</span>
        <span style={systemEventLineStyle} />
      </div>
    );
  }
  if (message.role === "reference") {
    return (
      <div style={referenceEventStyle}>
        <span style={referenceEventIconStyle}>↗</span>
        <span>Referenced action: {message.content}</span>
      </div>
    );
  }
  return <MessageRow from={message.role}>{message.content}</MessageRow>;
}

function FocusedActionDecisionRow({
  action,
}: {
  action: MerchantActionView | null;
}) {
  if (!action?.actionRunId || action.status !== "proposed") return null;
  return (
    <div style={decisionRowStyle}>
      {action.executable ? (
        <Form method="post" onSubmit={markApprovalSent}>
          <input type="hidden" name="intent" value="action.approve" />
          <input type="hidden" name="actionRunId" value={action.actionRunId} />
          <button type="submit" style={approveButtonStyle}>
            Approve
          </button>
        </Form>
      ) : null}
      <Form method="post">
        <input type="hidden" name="intent" value="action.defer" />
        <input type="hidden" name="actionRunId" value={action.actionRunId} />
        <input type="hidden" name="reason" value="defer" />
        <button type="submit" style={quietDecisionButtonStyle}>
          Not right now
        </button>
      </Form>
      {!action.executable ? (
        <div style={instructPathStyle}>
          <span style={instructLeadStyle}>
            {action.raise?.reason ??
              "This one's yours to make - I can't do it for you yet."}
          </span>
          <span style={instructDetailStyle}>
            {action.raise?.detail ?? "This action type is not live for execution yet."}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function actionForConversation(
  conversation: ChatConversation | null,
  actions: MerchantActionView[],
) {
  const focusedActionId = conversation?.focusedActionId ?? conversation?.focusedAction?.id;
  if (!focusedActionId) return null;
  return (
    actions.find((action) => action.id === focusedActionId) ??
    (conversation?.focusedAction
      ? {
          id: conversation.focusedAction.id,
          title: conversation.focusedAction.title,
          summary: conversation.focusedAction.summary ?? null,
          status: conversation.focusedAction.status ?? "proposed",
          sourceRecommendationId:
            conversation.focusedAction.sourceRecommendationId ?? null,
          actionRunId: conversation.focusedAction.actionRunId ?? null,
        }
      : null)
  );
}

function pickNextAction(actions: MerchantActionView[]) {
  return (
    actions.find((action) => action.status === "proposed") ??
    actions.find((action) => action.status === "accepted") ??
    actions.find((action) => action.status === "in_progress") ??
    null
  );
}

function isWorkingAction(action: MerchantActionView) {
  return action.status === "accepted" || action.status === "in_progress";
}

function isHistoricalAction(action: MerchantActionView) {
  return ["completed", "deferred", "declined", "superseded"].includes(
    action.status,
  );
}

function statusLabelForAction(status: string) {
  if (status === "in_progress") return "In progress";
  return status
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function compactText(value: string, max: number) {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function displayStepLabel(
  step: string | { label?: string | null },
  index: number,
) {
  if (typeof step === "string" && step.trim()) return step.trim();
  if (typeof step === "object" && step?.label) return String(step.label);
  return `Step ${index + 1}`;
}

function merchantActionFromPrimaryMove(
  move: PrimaryMove,
): MerchantActionView | null {
  if (move.state === "empty") return null;
  return {
    id: "",
    title: move.title,
    summary: move.summary,
    status: move.state === "in_progress" ? "in_progress" : "proposed",
    statusLabel: move.statusLabel,
    statusTone: move.statusTone,
    sourceRecommendationId: move.recommendationId,
    actionRunId: move.actionRunId,
    actionType: move.actionType,
    executable: move.executable,
    raise: move.raise,
    displaySteps: [
      move.whyThisAction,
      move.whyNow,
      move.successSignal ?? "",
    ].filter(Boolean),
    baselineSignal: move.baselineSignal,
    currentSignal: move.currentSignal,
  };
}

function conversationTitle(conversation: ChatConversation | null) {
  if (!conversation || conversation.title === "New conversation")
    return "New chat";
  return conversation.title;
}

function messageCountLabel(count: number | null | undefined) {
  const safeCount = Number.isFinite(Number(count)) ? Number(count) : 0;
  if (safeCount <= 0) return "No messages";
  return `${safeCount} message${safeCount === 1 ? "" : "s"}`;
}

function formatConversationDate(value: string, timeZone?: string | null) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
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
        {/* A retry is a wait too — the merchant is sitting through this one having
            already sat through a failure, so it is the last turn we'd want missing
            from the numbers. */}
        <Form method="post" preventScrollReset onSubmit={markChatTurnSent}>
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
  brandLogoUrl,
}: {
  storeName: string;
  todayLabel?: string;
  brandLogoUrl?: string | null;
}) {
  return (
    <header style={headerStyle}>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <StoreMark storeName={storeName} logoUrl={brandLogoUrl} />
          <strong style={{ fontSize: 14, color: COLORS.body }}>
            {storeName || "Jefe Store"}
          </strong>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <DateLabel>{todayLabel ?? ""}</DateLabel>
      </div>
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

function usePreserveChatScrollDuringIntent(
  navigation: ReturnType<typeof useNavigation>,
  intent: string,
) {
  const preservingRef = useRef(false);
  const snapshotRef = useRef({ y: 0, nearBottom: false });
  const restoreHandlesRef = useRef<{ frames: number[]; timeouts: number[] }>({
    frames: [],
    timeouts: [],
  });
  const pendingIntent =
    typeof navigation.formData?.get("intent") === "string"
      ? String(navigation.formData.get("intent"))
      : "";
  const active = navigation.state !== "idle" && pendingIntent === intent;

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      return undefined;
    }

    const capture = () => {
      snapshotRef.current = {
        y: window.scrollY,
        nearBottom: distanceFromDocumentBottom() < 160,
      };
    };

    if (active) {
      preservingRef.current = true;
      capture();
      window.addEventListener("scroll", capture, { passive: true });
      return () => window.removeEventListener("scroll", capture);
    }

    if (!preservingRef.current) return undefined;
    preservingRef.current = false;
    const snapshot = snapshotRef.current;
    clearScrollRestoreHandles(restoreHandlesRef.current);
    const restore = () => restoreChatScroll(snapshot);
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(restore);
      restoreHandlesRef.current.frames.push(secondFrame);
    });
    restoreHandlesRef.current.frames.push(firstFrame);
    restoreHandlesRef.current.timeouts.push(
      window.setTimeout(restore, 50),
      window.setTimeout(restore, 150),
    );

    return undefined;
  }, [active]);
}

function useScrollTranscriptToLatest(
  conversationId: string | null,
  messageCount: number,
) {
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const lastConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!conversationId) return undefined;
    const isOpeningConversation =
      lastConversationIdRef.current !== conversationId;
    lastConversationIdRef.current = conversationId;
    if (!isOpeningConversation) return undefined;
    const transcript = transcriptRef.current;
    if (!transcript) return undefined;

    const scrollToLatest = () => {
      transcript.scrollTop = transcript.scrollHeight;
    };
    scrollToLatest();
    if (typeof window === "undefined") return undefined;
    const frame = window.requestAnimationFrame(scrollToLatest);
    const timeout = window.setTimeout(scrollToLatest, 80);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [conversationId, messageCount]);

  return transcriptRef;
}

function restoreChatScroll(snapshot: { y: number; nearBottom: boolean }) {
  if (snapshot.nearBottom) {
    window.scrollTo({ top: document.documentElement.scrollHeight });
  } else {
    window.scrollTo({ top: snapshot.y });
  }
}

function clearScrollRestoreHandles(handles: {
  frames: number[];
  timeouts: number[];
}) {
  for (const frame of handles.frames) window.cancelAnimationFrame(frame);
  for (const timeout of handles.timeouts) window.clearTimeout(timeout);
  handles.frames = [];
  handles.timeouts = [];
}

function distanceFromDocumentBottom() {
  const scrollHeight = Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight ?? 0,
  );
  return Math.max(0, scrollHeight - (window.scrollY + window.innerHeight));
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
      raise: null,
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
      raise: null,
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
    raise: input.suggestedAction?.raise ?? null,
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
const chatPageStyle: CSSProperties = {
  ...pageStyle,
  boxSizing: "border-box",
  height: "100dvh",
  inset: 0,
  maxHeight: "100dvh",
  minHeight: 0,
  overscrollBehavior: "none",
  overflow: "hidden",
  padding: "32px 24px",
  position: "fixed",
  width: "100%",
};
const shellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 36,
  maxWidth: 760,
  margin: "0 auto",
  width: "100%",
};
const chatShellStyle: CSSProperties = {
  maxWidth: 760,
  height: "100%",
  minHeight: 0,
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
  letterSpacing: 0,
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
const homeHeroStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 22,
};
const spotlightStyle: CSSProperties = {
  ...cardStyle,
  gap: 18,
};
const spotlightTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontFamily: FONT.serif,
  fontSize: 30,
  fontWeight: 500,
  lineHeight: 1.2,
  margin: 0,
};
const actionButtonRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
};
const homeSectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
};
const homeSectionHeaderStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
};
const sectionTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontFamily: FONT.serif,
  fontSize: 24,
  fontWeight: 500,
  lineHeight: 1.25,
  margin: 0,
};
const chatListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 0,
};
const chatListItemStyle: CSSProperties = {
  alignItems: "flex-start",
  borderBottom: `1px solid ${COLORS.hairline}`,
  color: COLORS.ink,
  display: "flex",
  gap: 16,
  justifyContent: "space-between",
  padding: "14px 0",
  textDecoration: "none",
};
const chatListBodyStyle: CSSProperties = {
  display: "flex",
  flex: "1 1 auto",
  flexDirection: "column",
  gap: 5,
  minWidth: 0,
};
const chatListTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontSize: 14.5,
  fontWeight: 750,
  lineHeight: 1.3,
};
const chatListMetaLineStyle: CSSProperties = {
  alignItems: "center",
  color: COLORS.muted,
  display: "flex",
  flexWrap: "wrap",
  fontSize: 12.5,
  gap: "6px 12px",
  lineHeight: 1.35,
};
const chatFocusMetaStyle: CSSProperties = {
  alignItems: "center",
  color: COLORS.meta,
  display: "inline-flex",
  gap: 5,
  minWidth: 0,
};
const chatFocusLeadStyle: CSSProperties = {
  color: COLORS.body,
  fontWeight: 700,
};
const boltStyle: CSSProperties = {
  color: "#c49a1a",
  fontWeight: 800,
};
const chatListDateStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 11,
  lineHeight: 1.4,
  whiteSpace: "nowrap",
};
const actionListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};
const progressRowStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.hairline}`,
  borderRadius: 10,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "18px 20px",
};
const progressRowHeaderStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 10,
  justifyContent: "space-between",
};
const progressRowTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontSize: 15,
  fontWeight: 750,
  lineHeight: 1.25,
};
const actionCardSummaryStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 13.5,
  lineHeight: 1.45,
  margin: 0,
};
const stepInlineListStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: "8px 18px",
};
const stepInlineItemStyle: CSSProperties = {
  alignItems: "center",
  color: COLORS.body,
  display: "inline-flex",
  fontSize: 13,
  gap: 7,
  lineHeight: 1.35,
};
const stepGlyphStyle: CSSProperties = {
  color: COLORS.green,
  fontWeight: 800,
};
const progressRowFooterStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 14,
  justifyContent: "space-between",
};
const signalLineStyle: CSSProperties = {
  alignItems: "center",
  color: COLORS.meta,
  display: "flex",
  flexWrap: "wrap",
  fontSize: 12.5,
  gap: 8,
};
const historyRowStyle: CSSProperties = {
  ...chatListItemStyle,
};
const historyOutcomeStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 13,
  lineHeight: 1.45,
};
const historyStatusGroupStyle: CSSProperties = {
  alignItems: "flex-end",
  display: "flex",
  flexDirection: "column",
  flex: "0 0 auto",
  gap: 5,
};
const historyStatusStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1.25,
  textTransform: "uppercase",
};
const emptySectionStyle: CSSProperties = {
  background: "rgba(255, 253, 250, 0.64)",
  border: `1px dashed ${COLORS.border}`,
  borderRadius: 8,
  display: "flex",
  flexDirection: "column",
  gap: 5,
  padding: "18px 16px",
};
const inlineFormStyle: CSSProperties = {
  display: "inline-flex",
};
const pillButtonStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 999,
  color: COLORS.navy,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 13,
  fontWeight: 750,
  lineHeight: 1.2,
  padding: "8px 16px",
  whiteSpace: "nowrap",
};
const primaryButtonStyle: CSSProperties = {
  background: COLORS.navy,
  border: 0,
  borderRadius: 9,
  color: "#fff",
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 14,
  fontWeight: 750,
  lineHeight: 1.2,
  padding: "12px 20px",
};
const quietPillButtonStyle: CSSProperties = {
  ...pillButtonStyle,
};
const textButtonStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  color: COLORS.navy,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 13,
  fontWeight: 750,
  padding: 0,
};
const modalBackdropStyle: CSSProperties = {
  alignItems: "center",
  background: "rgba(31, 41, 51, 0.28)",
  display: "flex",
  inset: 0,
  justifyContent: "center",
  padding: 20,
  position: "fixed",
  zIndex: 40,
};
const chooserModalStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  boxShadow: "0 28px 80px rgba(31, 41, 51, 0.22)",
  display: "flex",
  flexDirection: "column",
  gap: 18,
  maxHeight: "min(680px, calc(100vh - 40px))",
  maxWidth: 560,
  overflowY: "auto",
  padding: 24,
  width: "100%",
};
const talkChooserModalStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 16,
  boxShadow: "0 24px 60px rgba(39, 55, 77, 0.18)",
  display: "flex",
  flexDirection: "column",
  gap: 18,
  maxHeight: "min(620px, calc(100vh - 40px))",
  maxWidth: 480,
  overflowY: "auto",
  padding: 28,
  width: "100%",
};
const talkChooserLeadStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 15,
  lineHeight: 1.5,
  margin: 0,
};
const talkChooserStrongStyle: CSSProperties = {
  color: COLORS.ink,
  fontWeight: 700,
};
const talkChooserListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const talkChooserCardStyle: CSSProperties = {
  background: "#f8f5f0",
  border: "1px solid #e2dbd2",
  borderRadius: 10,
  color: COLORS.ink,
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "13px 15px",
  textDecoration: "none",
};
const talkChooserCardTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontSize: 14.5,
  fontWeight: 700,
  lineHeight: 1.25,
};
const talkChooserCardMetaStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 12.5,
  fontWeight: 400,
  lineHeight: 1.25,
};
const talkChooserDividerStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.hairline}`,
  height: 1,
  width: "100%",
};
const talkChooserActionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  paddingTop: 0,
};
const talkChooserPrimaryButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  borderRadius: 8,
  fontSize: 13.5,
  padding: "11px 20px",
};
const talkChooserCancelStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 13.5,
  fontWeight: 600,
  lineHeight: 1.2,
  padding: "11px 4px",
  textDecoration: "none",
};
const modalHeaderStyle: CSSProperties = {
  alignItems: "flex-start",
  display: "flex",
  gap: 16,
  justifyContent: "space-between",
};
const modalTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontFamily: FONT.serif,
  fontSize: 24,
  fontWeight: 500,
  lineHeight: 1.25,
  margin: "6px 0 0",
};
const modalCloseButtonStyle: CSSProperties = {
  background: "none",
  border: 0,
  color: COLORS.muted,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 28,
  lineHeight: 1,
  padding: 0,
};
const modalActionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
};
const actionMenuStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
};
const actionMenuGroupStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 9,
};
const actionMenuButtonStyle: CSSProperties = {
  background: "rgba(251, 250, 247, 0.78)",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  color: COLORS.ink,
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  fontFamily: FONT.sans,
  gap: 4,
  padding: "10px 12px",
  textAlign: "left",
  width: "100%",
};
const attachMenuPanelStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 12,
  boxShadow: "0 18px 44px rgba(39,55,77,0.10)",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  marginBottom: 12,
  maxHeight: "min(420px, 45vh)",
  overflowY: "auto",
  padding: 16,
};
const attachMenuHeaderStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
};
const attachMenuCloseStyle: CSSProperties = {
  background: "transparent",
  border: 0,
  color: COLORS.meta,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 13,
  fontWeight: 700,
  padding: 0,
};
const systemEventStyle: CSSProperties = {
  alignItems: "center",
  alignSelf: "center",
  display: "flex",
  gap: 18,
  justifyContent: "center",
  padding: "22px 0 18px",
  width: "100%",
};
const systemEventLineStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.hairline}`,
  flex: "1 1 auto",
  minWidth: 32,
};
const systemEventTextStyle: CSSProperties = {
  color: COLORS.meta,
  flex: "0 1 auto",
  fontFamily: FONT.mono,
  fontSize: 14,
  fontWeight: 700,
  lineHeight: 1.35,
  textAlign: "center",
};
const referenceEventStyle: CSSProperties = {
  alignItems: "center",
  alignSelf: "flex-start",
  border: `1px dashed ${COLORS.border}`,
  borderRadius: 10,
  color: COLORS.body,
  display: "inline-flex",
  fontSize: 13,
  fontWeight: 700,
  gap: 8,
  padding: "8px 12px",
};
const referenceEventIconStyle: CSSProperties = {
  color: COLORS.navy,
  fontSize: 14,
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
function chatTitleInlineInputStyle(active: boolean): CSSProperties {
  return {
    background: active ? COLORS.card : "transparent",
    border: `1px solid ${active ? COLORS.border : "transparent"}`,
    borderRadius: 10,
    boxSizing: "border-box",
    color: COLORS.ink,
    display: "block",
    fontFamily: FONT.serif,
    fontSize: 26,
    fontWeight: 500,
    lineHeight: 1.28,
    marginLeft: -14,
    minWidth: 0,
    outline: "none",
    padding: "6px 14px",
    width: "calc(100% + 28px)",
  };
}
const chatTitleBlockStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "26px 0 10px",
};
const focusStripWrapStyle: CSSProperties = {
  background: COLORS.page,
  display: "flex",
  flexDirection: "column",
  flex: "0 0 auto",
  padding: "12px 0",
  zIndex: 12,
};
const focusPanelStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 10,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};
const focusStripButtonStyle: CSSProperties = {
  alignItems: "center",
  background: "transparent",
  border: 0,
  borderRadius: 0,
  color: COLORS.ink,
  cursor: "pointer",
  display: "flex",
  fontFamily: FONT.sans,
  gap: 16,
  justifyContent: "space-between",
  outline: "none",
  padding: "18px 20px",
  textAlign: "left",
  width: "100%",
};
const focusStripLeftStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "1 1 auto",
  gap: 12,
  minWidth: 0,
};
const focusStripTextStyle: CSSProperties = {
  display: "flex",
  flex: "1 1 auto",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
};
const focusStripRightStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flex: "0 0 auto",
  gap: 14,
};
const focusStripLabelStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 13,
  fontWeight: 700,
  lineHeight: 1.25,
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};
const focusStripTitleStyle: CSSProperties = {
  flex: "1 1 auto",
  fontSize: 15,
  fontWeight: 750,
  lineHeight: 1.25,
  minWidth: 0,
};
const focusStripChevronStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 12,
  lineHeight: 1,
};
const focusDetailStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.hairline}`,
  display: "flex",
  flexDirection: "column",
  gap: 18,
  padding: "22px 28px 24px",
};
const focusDetailSummaryStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 16,
  lineHeight: 1.5,
  margin: 0,
};
const focusSignalStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 13,
  fontWeight: 600,
};

function focusStatusStyle(status: string): CSSProperties {
  const active = status === "in_progress" || status === "completed";
  return {
    color: active ? COLORS.green : COLORS.meta,
    fontFamily: FONT.mono,
    fontSize: 13,
    fontWeight: 700,
    lineHeight: 1.25,
    whiteSpace: "nowrap",
  };
}
const messagesStyle: CSSProperties = {
  flex: "1 1 auto",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  minHeight: 0,
  overflowY: "auto",
  overscrollBehavior: "contain",
  padding: "36px 4px 56px 0",
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
// Deliberately reads as a considered position, not a greyed-out control. Same weight and
// colour as anything else Jefe says — an instruction is the product working, not degraded.
const instructPathStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  maxWidth: "86%",
};
const instructLeadStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 15,
  lineHeight: 1.6,
};
const instructDetailStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 13.5,
  lineHeight: 1.5,
};
const thinkingStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 15,
  lineHeight: 1.6,
  paddingTop: 1,
};
const chatComposerWrapStyle: CSSProperties = {
  flex: "none",
  background: COLORS.page,
  bottom: 0,
  paddingTop: 18,
  position: "sticky",
  zIndex: 14,
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
// Kept in the form (not display:none) so the browser still submits it and the click-through
// from the paperclip button works. Visually hidden, never focusable — the button is the control.
const hiddenFileInputStyle: CSSProperties = {
  height: 0,
  opacity: 0,
  position: "absolute",
  pointerEvents: "none",
  width: 0,
};
const attachedFileRowStyle: CSSProperties = {
  alignItems: "center",
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 999,
  display: "inline-flex",
  gap: 10,
  marginBottom: 8,
  maxWidth: "100%",
  padding: "6px 8px 6px 14px",
};
const attachedFileNameStyle: CSSProperties = {
  color: COLORS.navy,
  fontFamily: FONT.sans,
  fontSize: 13,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const attachedFileRemoveStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: COLORS.muted,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 12,
  padding: "2px 6px",
  textDecoration: "underline",
};
const composerErrorStyle: CSSProperties = {
  color: COLORS.navy,
  fontFamily: FONT.sans,
  fontSize: 13,
  marginBottom: 8,
};
function attachButtonStyle(active: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: active ? COLORS.navy : "transparent",
    border: `1px solid ${active ? COLORS.navy : COLORS.border}`,
    borderRadius: 999,
    color: active ? "#fff" : COLORS.navy,
    cursor: "pointer",
    display: "inline-flex",
    flex: "0 0 auto",
    fontFamily: FONT.sans,
    fontSize: 20,
    fontWeight: 500,
    height: 34,
    justifyContent: "center",
    lineHeight: 1,
    padding: 0,
    width: 34,
  };
}
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
