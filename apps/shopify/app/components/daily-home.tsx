import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
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
import { layoutChart } from "../lib/charts/chart-layout.js";
import { formatDateInZone } from "../lib/home/home-dates.js";
import type {
  ExecutedAction,
  Goal,
  Insight,
  MemoryQuestion,
  MemoryView,
  Metrics,
  Recommendation,
  RecommendationWorkflow,
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
  workflowSteps: WorkflowStep[];
};

type WorkflowStep = {
  id: string;
  title: string;
  description: string;
  completionCriteria: string | null;
  status: string;
  mode: string;
  capabilityRef: string | null;
};

type WorkflowStepDisplay =
  | string
  | {
      id?: string | null;
      label?: string | null;
      title?: string | null;
      description?: string | null;
      completionCriteria?: string | null;
      status?: string | null;
      mode?: string | null;
      capabilityRef?: string | null;
      statusReason?: string | null;
      progress?: Record<string, unknown> | null;
      attention?: Record<string, unknown> | null;
      startedAt?: string | null;
      completedAt?: string | null;
      done?: boolean | null;
    };

type StepTreatment = "completed" | "current" | "future";

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
  executionStatus?: string | null;
  outcomeStatus?: string | null;
  raise?: { reason: string; detail: string | null } | null;
  progress?: Record<string, unknown> | null;
  currentStep?: WorkflowStepDisplay | null;
  workflow?: { steps?: WorkflowStepDisplay[] | null } | null;
  displaySteps?: WorkflowStepDisplay[];
  successText?: string | null;
  baselineSignal?: string | null;
  currentSignal?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
};

type MerchantAttentionItem = {
  attentionType: string;
  priority: number;
  title: string;
  explanation: string;
  actionId: string | null;
  actionRunId: string | null;
  stepId?: string | null;
  ctaLabel: string | null;
  ctaIntent: string | null;
  waitingSince?: string | null;
  action: MerchantActionView | null;
};

type FocusedActionChatChoice = {
  id: string;
  title: string;
  messageCount?: number | null;
  lastMessageAt?: string | null;
  createdAt?: string | null;
};
type ConversationResourceData = {
  ok?: boolean;
  conversation?: ChatThread;
  libraryFiles?: LibraryPick[];
  error?: string;
};
type ActionChatsResourceData = {
  ok?: boolean;
  actionId?: string;
  chooser?: boolean;
  chats?: FocusedActionChatChoice[];
  conversationId?: string;
  error?: string;
};

export function DailyHome(props: {
  storeName: string;
  merchantName?: string;
  metrics?: Metrics;
  memory?: MemoryView;
  recommendation?: Recommendation;
  suggestedAction?: SuggestedAction | null;
  executedActions?: ExecutedAction[];
  insights?: Insight[];
  goals?: Goal[];
  actionModes?: Record<string, string>;
  channels?: ChannelConn[];
  conversation?: ChatThread | null;
  merchantActions?: MerchantActionView[];
  attentionItems?: MerchantAttentionItem[];
  proposedActions?: MerchantActionView[];
  inProgressActions?: MerchantActionView[];
  completedActions?: MerchantActionView[];
  /** Files the merchant kept, so a chat can reuse one without re-uploading it. */
  libraryFiles?: LibraryPick[];
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
  horizonNear?: HorizonItem[];
  horizonWatching?: HorizonWatch[];
  todayLabel?: string; // loader-computed, store-tz-pinned; replaces render-time new Date()
  storeTimeZone?: string | null; // the store's IANA zone; pins fixed-instant date labels
  horizonHeadsUps?: HeadsUp[]; // proactive run-out / refund heads-ups, rendered as messages
  brandLogoUrl?: string | null; // merchant's brand logo for the header; monogram fallback
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const params = new URLSearchParams(location.search);
  const openConversationId = params.get("conversation");
  const talkActionId = params.get("talkAction");
  const conversationFetcher = useFetcher<ConversationResourceData>();
  const actionChatsFetcher = useFetcher<ActionChatsResourceData>();
  const startActionChatFetcher = useFetcher<ActionChatsResourceData>();
  const [conversationCache, setConversationCache] = useState<
    Record<string, { conversation: ChatThread; libraryFiles: LibraryPick[] }>
  >({});
  const [actionChatsCache, setActionChatsCache] = useState<Record<string, FocusedActionChatChoice[]>>({});
  const [pendingTalkActionId, setPendingTalkActionId] = useState<string | null>(null);
  const [startActionChatError, setStartActionChatError] = useState<string | null>(null);
  const handledStartActionChatDataRef = useRef<ActionChatsResourceData | undefined>(undefined);
  const pendingThreadRefreshRef = useRef<string | null>(null);
  const suggestedAction = props.suggestedAction ?? null;
  const executedActions = props.executedActions ?? [];
  const goals = props.goals ?? [];
  const primaryMove = buildPrimaryMove({
    recommendation: props.recommendation ?? null,
    suggestedAction,
    actions: executedActions,
    goals,
    storeTimeZone: props.storeTimeZone,
  });
  const fallbackAction = merchantActionFromPrimaryMove(primaryMove);
  const merchantActions =
    props.merchantActions && props.merchantActions.length > 0
      ? props.merchantActions
      : fallbackAction
        ? [fallbackAction]
        : [];
  const fetchedConversation = useMemo(
    () => conversationPayloadFromResource(conversationFetcher.data),
    [conversationFetcher.data],
  );
  const cachedConversation = openConversationId ? conversationCache[openConversationId] : null;
  const loaderConversation =
    openConversationId && props.conversation?.conversation?.id === openConversationId
      ? { conversation: props.conversation, libraryFiles: props.libraryFiles ?? [] }
      : null;
  const openConversationPayload =
    (fetchedConversation?.conversation.conversation?.id === openConversationId
      ? fetchedConversation
      : null) ??
    cachedConversation ??
    loaderConversation;
  const activeConversation = openConversationPayload?.conversation.conversation ?? null;
  const focusedAction = actionForConversation(activeConversation, merchantActions);
  const displayedTalkActionId = talkActionId ?? pendingTalkActionId;
  const fetchedActionChats = useMemo(
    () =>
      actionChatsFetcher.data?.ok && actionChatsFetcher.data.actionId === talkActionId
        ? (actionChatsFetcher.data.chats ?? [])
        : null,
    [actionChatsFetcher.data, talkActionId],
  );
  const cachedActionChats = talkActionId ? actionChatsCache[talkActionId] : null;
  const actionChats = useMemo(
    () =>
      fetchedActionChats ??
      cachedActionChats ??
      (talkActionId && props.talkActionId === talkActionId
        ? (props.focusedActionChats ?? [])
        : []),
    [
      cachedActionChats,
      fetchedActionChats,
      props.focusedActionChats,
      props.talkActionId,
      talkActionId,
    ],
  );
  const actionChatsLoading =
    (Boolean(pendingTalkActionId) && startActionChatFetcher.state !== "idle") ||
    (Boolean(talkActionId) &&
      !cachedActionChats &&
      actionChatsFetcher.state !== "idle");

  useEffect(() => {
    const onlyChatId = actionChats.length === 1 ? actionChats[0]?.id : null;
    if (!talkActionId || !onlyChatId || actionChatsLoading) return;
    navigate(
      searchWith(location.search, {
        conversation: onlyChatId,
        talkAction: null,
      }),
      { preventScrollReset: true },
    );
  }, [actionChats, actionChatsLoading, location.search, navigate, talkActionId]);

  const startFocusedChat = (actionId: string, forceNew = false) => {
    if (!actionId || startActionChatFetcher.state !== "idle") return;
    setPendingTalkActionId(actionId);
    setStartActionChatError(null);
    const formData = new FormData();
    formData.set("intent", "chat.focus.start");
    formData.set("focusedActionId", actionId);
    if (forceNew) formData.set("forceNew", "true");
    startActionChatFetcher.submit(formData, {
      method: "post",
      action: "/api/app-home/action-chats",
    });
  };

  const closeTalkAction = () => {
    if (startActionChatFetcher.state !== "idle") return;
    setPendingTalkActionId(null);
    setStartActionChatError(null);
    navigate(searchWith(location.search, { talkAction: null }), {
      preventScrollReset: true,
    });
  };

  useEffect(() => {
    if (!openConversationId) return;
    if (conversationCache[openConversationId]) return;
    if (fetchedConversation?.conversation.conversation?.id === openConversationId) return;
    if (conversationFetcher.state !== "idle") return;
    conversationFetcher.load(
      `/api/app-home/conversation?conversationId=${encodeURIComponent(openConversationId)}`,
    );
  }, [openConversationId, conversationCache, fetchedConversation, conversationFetcher]);

  useEffect(() => {
    const payload = conversationPayloadFromResource(conversationFetcher.data);
    const id = payload?.conversation.conversation?.id;
    if (!payload || !id) return;
    const handle = window.setTimeout(() => {
      setConversationCache((cache) => ({ ...cache, [id]: payload }));
    }, 0);
    return () => window.clearTimeout(handle);
  }, [conversationFetcher.data]);

  useEffect(() => {
    if (!openConversationId) return;
    const intent = String(navigation.formData?.get("intent") ?? "");
    if (navigation.state !== "idle" && isThreadMutationIntent(intent)) {
      pendingThreadRefreshRef.current = openConversationId;
      return;
    }
    if (navigation.state !== "idle") return;
    const refreshId = pendingThreadRefreshRef.current;
    if (!refreshId) return;
    pendingThreadRefreshRef.current = null;
    const handle = window.setTimeout(() => {
      setConversationCache((cache) => {
        const next = { ...cache };
        delete next[refreshId];
        return next;
      });
    }, 0);
    conversationFetcher.load(
      `/api/app-home/conversation?conversationId=${encodeURIComponent(refreshId)}`,
    );
    return () => window.clearTimeout(handle);
  }, [openConversationId, navigation.state, navigation.formData, conversationFetcher]);

  useEffect(() => {
    if (!talkActionId) return;
    if (actionChatsCache[talkActionId]) return;
    if (fetchedActionChats) return;
    if (actionChatsFetcher.state !== "idle") return;
    actionChatsFetcher.load(
      `/api/app-home/action-chats?actionId=${encodeURIComponent(talkActionId)}`,
    );
  }, [talkActionId, actionChatsCache, fetchedActionChats, actionChatsFetcher]);

  useEffect(() => {
    const data = actionChatsFetcher.data;
    if (!data?.ok || !data.actionId) return;
    const handle = window.setTimeout(() => {
      setActionChatsCache((cache) => ({ ...cache, [data.actionId as string]: data.chats ?? [] }));
    }, 0);
    return () => window.clearTimeout(handle);
  }, [actionChatsFetcher.data]);

  useEffect(() => {
    const data = startActionChatFetcher.data;
    if (
      startActionChatFetcher.state !== "idle" ||
      !pendingTalkActionId ||
      !data ||
      data === handledStartActionChatDataRef.current ||
      data.actionId !== pendingTalkActionId
    ) return;
    handledStartActionChatDataRef.current = data;
    const handle = window.setTimeout(() => {
      if (!data.ok) {
        setStartActionChatError(data.error ?? "That chat could not be opened.");
        return;
      }
      if (data.chooser) {
        if (data.chats?.length === 1 && data.chats[0]?.id) {
          navigate(
            searchWith(location.search, {
              conversation: data.chats[0].id,
              talkAction: null,
            }),
            { preventScrollReset: true },
          );
          setPendingTalkActionId(null);
          return;
        }
        setActionChatsCache((cache) => ({
          ...cache,
          [pendingTalkActionId]: data.chats ?? [],
        }));
        navigate(
          searchWith(location.search, {
            conversation: null,
            talkAction: pendingTalkActionId,
          }),
          { preventScrollReset: true },
        );
      } else if (data.conversationId) {
        navigate(
          searchWith(location.search, {
            conversation: data.conversationId,
            talkAction: null,
          }),
          { preventScrollReset: true },
        );
      }
      setPendingTalkActionId(null);
    }, 0);
    return () => window.clearTimeout(handle);
  }, [
    location.search,
    navigate,
    pendingTalkActionId,
    startActionChatFetcher.data,
    startActionChatFetcher.state,
  ]);

  if (openConversationId || activeConversation) {
    if (!openConversationPayload) {
      if (conversationFetcher.state === "idle" && conversationFetcher.data?.ok === false) {
        return (
          <FocusedConversation
            conversation={null}
            focusedAction={null}
            merchantActions={merchantActions}
            libraryFiles={[]}
            currentSearch={location.search}
            todayLabel={props.todayLabel}
          />
        );
      }
      return (
        <FocusedConversationLoading
          currentSearch={location.search}
          todayLabel={props.todayLabel}
        />
      );
    }
    return (
      <FocusedConversation
        conversation={openConversationPayload.conversation}
        focusedAction={focusedAction}
        merchantActions={merchantActions}
        libraryFiles={openConversationPayload.libraryFiles}
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
          attentionItems={props.attentionItems ?? []}
          proposedActions={props.proposedActions ?? []}
          inProgressActions={props.inProgressActions ?? []}
          completedActions={props.completedActions ?? []}
          talkActionId={displayedTalkActionId}
          focusedActionChats={actionChats}
          focusedActionChatsLoading={actionChatsLoading}
          focusedActionChatError={startActionChatError}
          startingActionId={
            startActionChatFetcher.state === "idle" ? null : pendingTalkActionId
          }
          onStartFocusedChat={startFocusedChat}
          onCloseTalkAction={closeTalkAction}
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

function isThreadMutationIntent(intent: string) {
  return [
    "chat.message",
    "chat.retry",
    "chat.rename",
    "chat.focus.change",
    "chat.action.reference",
  ].includes(intent);
}

function conversationPayloadFromResource(data: ConversationResourceData | undefined) {
  const thread = data?.conversation;
  if (!data?.ok || !thread?.conversation) return null;
  return {
    conversation: thread,
    libraryFiles: data.libraryFiles ?? [],
  };
}

function FocusedActionsHome({
  conversations,
  merchantActions,
  attentionItems,
  proposedActions,
  inProgressActions,
  completedActions,
  talkActionId,
  focusedActionChats,
  focusedActionChatsLoading,
  focusedActionChatError,
  startingActionId,
  onStartFocusedChat,
  onCloseTalkAction,
  currentSearch,
  storeTimeZone,
}: {
  conversations: ChatConversation[];
  merchantActions: MerchantActionView[];
  attentionItems: MerchantAttentionItem[];
  proposedActions: MerchantActionView[];
  inProgressActions: MerchantActionView[];
  completedActions: MerchantActionView[];
  talkActionId: string | null;
  focusedActionChats: FocusedActionChatChoice[];
  focusedActionChatsLoading?: boolean;
  focusedActionChatError?: string | null;
  startingActionId?: string | null;
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
  onCloseTalkAction: () => void;
  currentSearch: string;
  storeTimeZone?: string | null;
}) {
  const attentionQueue = normalizeAttentionItems(attentionItems, merchantActions);
  const [selectedAttentionKey, setSelectedAttentionKey] = useState<string | null>(null);
  const matchedAttentionIndex = selectedAttentionKey
    ? attentionQueue.findIndex((candidate) => attentionIdentity(candidate) === selectedAttentionKey)
    : -1;
  const selectedAttentionIndex =
    matchedAttentionIndex >= 0 ? matchedAttentionIndex : 0;
  const attentionItem = attentionQueue[selectedAttentionIndex] ?? null;
  const proposed =
    proposedActions.length > 0
      ? proposedActions
      : merchantActions.filter((action) => action.status === "proposed");
  const inProgress =
    inProgressActions.length > 0
      ? inProgressActions
      : merchantActions.filter(isWorkingAction);
  const completed =
    completedActions.length > 0
      ? completedActions
      : merchantActions.filter(isCompletedAction);
  const talkAction = talkActionId
    ? merchantActions.find((action) => action.id === talkActionId) ?? null
    : null;

  return (
    <>
      {attentionItem ? (
        <section style={homeHeroStyle} aria-label="Needs your attention">
          <h1 style={headlineStyle}>
            {attentionQueue.length === 1
              ? "Needs your attention"
              : `${attentionQueue.length} things need your attention`}
          </h1>
          <AttentionSpotlight
            item={attentionItem}
            attentionCount={attentionQueue.length}
            attentionIndex={selectedAttentionIndex}
            onStartFocusedChat={onStartFocusedChat}
            onPreviousAttention={() =>
              setSelectedAttentionKey(
                attentionIdentity(
                  attentionQueue[
                    (selectedAttentionIndex - 1 + attentionQueue.length) %
                      attentionQueue.length
                  ] ?? attentionItem,
                ),
              )
            }
            onNextAttention={() =>
              setSelectedAttentionKey(
                attentionIdentity(
                  attentionQueue[
                    (selectedAttentionIndex + 1) % attentionQueue.length
                  ] ?? attentionItem,
                ),
              )
            }
          />
        </section>
      ) : null}

      {proposed.length > 0 ? (
        <ActionShelf
          title={`Proposed · ${proposed.length}`}
          emptyTitle=""
          emptyBody=""
          actions={proposed}
          currentSearch={currentSearch}
          variant="proposed"
          onStartFocusedChat={onStartFocusedChat}
        />
      ) : null}

      {inProgress.length > 0 ? (
        <ActionShelf
          title={`In progress · ${inProgress.length}`}
          emptyTitle=""
          emptyBody=""
          actions={inProgress}
          currentSearch={currentSearch}
          variant="progress"
          onStartFocusedChat={onStartFocusedChat}
        />
      ) : null}

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
        title={`Completed · ${completed.length}`}
        emptyTitle="No completed actions yet"
        emptyBody="Finished actions will appear here."
        actions={completed}
        currentSearch={currentSearch}
        variant="history"
        onStartFocusedChat={onStartFocusedChat}
      />

      <TalkActionChooser
        action={talkAction}
        chats={focusedActionChats}
        loading={focusedActionChatsLoading}
        error={focusedActionChatError}
        starting={startingActionId === talkAction?.id}
        onStartFocusedChat={onStartFocusedChat}
        onClose={onCloseTalkAction}
        currentSearch={currentSearch}
        storeTimeZone={storeTimeZone}
      />
    </>
  );
}

function AttentionSpotlight({
  item,
  attentionCount,
  attentionIndex,
  onStartFocusedChat,
  onPreviousAttention,
  onNextAttention,
}: {
  item: MerchantAttentionItem;
  attentionCount: number;
  attentionIndex: number;
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
  onPreviousAttention: () => void;
  onNextAttention: () => void;
}) {
  const controls =
    attentionCount > 1 ? (
      <div style={focusCarouselStyle} aria-label="Attention queue">
        <button
          type="button"
          aria-label="Previous attention item"
          onClick={onPreviousAttention}
          style={focusArrowButtonStyle}
        >
          ‹
        </button>
        <span style={focusCounterStyle}>
          {attentionIndex + 1} of {attentionCount}
        </span>
        <button
          type="button"
          aria-label="Next attention item"
          onClick={onNextAttention}
          style={focusArrowButtonStyle}
        >
          ›
        </button>
      </div>
    ) : null;
  const action = item.action;
  if (!action) {
    return (
      <section style={spotlightStyle}>
        <div style={spotlightTopStyle}>
          <Mono>{attentionLabel(item.attentionType)}</Mono>
          {controls}
        </div>
        <h2 style={spotlightTitleStyle}>{item.title}</h2>
        <p style={summaryStyle}>{item.explanation}</p>
      </section>
    );
  }

  const steps = action.displaySteps?.slice(0, 4) ?? [];

  return (
    <section style={spotlightStyle}>
      <div style={spotlightTopStyle}>
        <Mono>{attentionLabel(item.attentionType)}</Mono>
        <div style={spotlightMetaGroupStyle}>
          <WorkflowStatusSummary action={action} stepCount={steps.length} />
          {controls}
        </div>
      </div>
      <h2 style={spotlightTitleStyle}>{action.title}</h2>
      <p style={summaryStyle}>{item.explanation || action.summary}</p>
      {steps.length > 0 ? (
        <WorkflowStepList
          steps={steps}
          heading="HOW IT WOULD WORK"
          variant="spotlight"
        />
      ) : null}
      <div style={actionButtonRowStyle}>
        <AttentionCta
          item={item}
          action={action}
          onStartFocusedChat={onStartFocusedChat}
        />
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
  onStartFocusedChat,
}: {
  title: string;
  emptyTitle: string;
  emptyBody: string;
  actions: MerchantActionView[];
  currentSearch: string;
  variant: "proposed" | "progress" | "history";
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
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
            ) : variant === "proposed" ? (
              <ActionProposedRow
                key={action.id || action.title}
                action={action}
                onStartFocusedChat={onStartFocusedChat}
              />
            ) : (
              <ActionProgressRow
                key={action.id || action.title}
                action={action}
                onStartFocusedChat={onStartFocusedChat}
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

function ActionProposedRow({
  action,
  onStartFocusedChat,
}: {
  action: MerchantActionView;
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
}) {
  return (
    <article style={proposedCardStyle}>
      <div style={inProgressHeaderStyle}>
        <h3 style={inProgressTitleStyle}>{action.title}</h3>
        <span style={proposedBadgeStyle}>
          <span style={proposedBadgeDotStyle} />
          Proposed
        </span>
      </div>
      {action.summary ? (
        <p style={proposedSummaryStyle}>{compactText(action.summary, 260)}</p>
      ) : null}
      <div style={proposedFooterStyle}>
        <div style={proposedSignalLineStyle}>
          {action.baselineSignal ? <span>{action.baselineSignal}</span> : null}
          {action.currentSignal ? <strong>{action.currentSignal}</strong> : null}
        </div>
        <TalkThisThroughButton
          action={action}
          linkLike
          onStartFocusedChat={onStartFocusedChat}
        />
      </div>
    </article>
  );
}

function ActionProgressRow({
  action,
  onStartFocusedChat,
}: {
  action: MerchantActionView;
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
}) {
  const progressState = actionProgressState(action);
  const displaySteps = action.displaySteps?.slice(0, 4) ?? [];
  const progressBadge = progressBadgeLabel(action, displaySteps);
  const footerText = progressFooterText(action, progressState.currentStepIndex);
  return (
    <article style={inProgressCardStyle}>
      <div style={inProgressHeaderStyle}>
        <h3 style={inProgressTitleStyle}>{action.title}</h3>
        <span style={inProgressBadgeStyle}>
          <span style={inProgressBadgeDotStyle} />
          {progressBadge}
        </span>
      </div>
      {displaySteps.length > 0 ? (
        <div style={inProgressStepsStyle}>
          {displaySteps.map((step, index) => {
            const treatment = stepTreatment(
              step,
              index,
              progressState.currentStepIndex,
            );
            return (
              <InProgressStepRow
                key={`${displayStepLabel(step, index)}-${index}`}
                step={step}
                index={index}
                treatment={treatment}
              />
            );
          })}
        </div>
      ) : null}
      <div style={inProgressFooterStyle}>
        <span style={inProgressFooterTextStyle}>{footerText}</span>
        <TalkThisThroughButton
          action={action}
          linkLike
          onStartFocusedChat={onStartFocusedChat}
        />
      </div>
    </article>
  );
}

function InProgressStepRow({
  step,
  index,
  treatment,
}: {
  step: WorkflowStepDisplay;
  index: number;
  treatment: StepTreatment;
}) {
  const ownerBadge = workflowStepOwnerBadge(step);
  return (
    <div style={inProgressStepRowStyle(treatment)}>
      <span style={inProgressStepNumberStyle}>{index + 1}.</span>
      {ownerBadge ? (
        <span style={inProgressOwnerBadgeStyle(ownerBadge, treatment)}>
          {ownerBadge}
        </span>
      ) : (
        <span />
      )}
      <span style={inProgressStepTitleStyle(treatment)}>
        {displayStepLabel(step, index)}
      </span>
      <span style={inProgressStepStatusStyle(treatment, step)}>
        {inProgressStepStatusLabel(treatment, step)}
      </span>
    </div>
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
  label = "Talk this through",
  onStartFocusedChat,
}: {
  action: MerchantActionView;
  primary?: boolean;
  linkLike?: boolean;
  label?: string;
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
}) {
  return (
    <button
      type="button"
      style={linkLike ? textButtonStyle : primary ? primaryButtonStyle : quietPillButtonStyle}
      disabled={!action.id}
      onClick={() => onStartFocusedChat(action.id)}
    >
      {label}{primary || linkLike ? " →" : ""}
    </button>
  );
}

function AttentionCta({
  item,
  action,
  onStartFocusedChat,
}: {
  item: MerchantAttentionItem;
  action: MerchantActionView;
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
}) {
  if (item.ctaIntent === "action.approve" && item.actionRunId) {
    return (
      <Form method="post" style={inlineFormStyle} onSubmit={markApprovalSent}>
        <input type="hidden" name="intent" value="action.approve" />
        <input type="hidden" name="actionRunId" value={item.actionRunId} />
        <button type="submit" style={primaryButtonStyle}>
          {item.ctaLabel ?? "Start next step"} →
        </button>
      </Form>
    );
  }
  return (
    <TalkThisThroughButton
      action={action}
      primary
      label={item.ctaLabel ?? "Review"}
      onStartFocusedChat={onStartFocusedChat}
    />
  );
}

function TalkActionChooser({
  action,
  chats,
  loading = false,
  error,
  starting = false,
  onStartFocusedChat,
  onClose,
  currentSearch,
  storeTimeZone,
}: {
  action: MerchantActionView | null;
  chats: FocusedActionChatChoice[];
  loading?: boolean;
  error?: string | null;
  starting?: boolean;
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
  onClose: () => void;
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
        {error ? (
          <EmptySection title="Chat could not be opened" body={error} />
        ) : loading ? (
          <EmptySection
            title="Opening your chat"
            body="Jefe is getting the focused thread ready."
          />
        ) : chats.length > 0 ? (
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
          <button
            type="button"
            onClick={() => onStartFocusedChat(action.id, true)}
            disabled={starting}
            style={talkChooserPrimaryButtonStyle}
          >
            {starting ? "Opening chat…" : "Start a new chat"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={starting}
            style={talkChooserCancelStyle}
          >
            Cancel
          </button>
        </div>
      </section>
    </div>
  );
}

function FocusedConversationLoading({
  currentSearch,
  todayLabel,
}: {
  currentSearch: string;
  todayLabel?: string;
}) {
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
        <EmptySection title="Opening chat" body="Loading the latest thread." />
      </div>
    </main>
  );
}

function FocusedConversation({
  conversation,
  focusedAction,
  merchantActions,
  libraryFiles,
  currentSearch,
  todayLabel,
}: {
  conversation: ChatThread | null;
  focusedAction: MerchantActionView | null;
  merchantActions: MerchantActionView[];
  libraryFiles: LibraryPick[];
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
  const [focusExpanded, setFocusExpanded] = useState(true);
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
  const [keepFile, setKeepFile] = useState(false);
  // A file the merchant already sent Jefe, pulled back into this turn. This is the "draw from
  // again" half of the library — without it, keeping a file only means it is not deleted.
  const [pickedFile, setPickedFile] = useState<LibraryPick | null>(null);
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
    setKeepFile(false);
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
    setKeepFile(false);
    setPickedFile(null);
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
          <>
            <FocusedActionStrip
              focusedAction={focusedAction}
              focusExpanded={focusExpanded}
              onToggle={() => setFocusExpanded(!focusExpanded)}
            />
            {focusExpanded ? (
              <FocusedActionLifecyclePanel action={focusedAction} />
            ) : null}
          </>
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
              {libraryFiles.length > 0 ? (
                <div style={libraryPickSectionStyle}>
                  <Mono>OR USE A FILE YOU ALREADY SENT ME</Mono>
                  <div style={libraryPickListStyle}>
                    {libraryFiles.map((file) => (
                      <button
                        key={file.id}
                        type="button"
                        style={libraryPickButtonStyle}
                        onClick={() => {
                          setMenuOpen(false);
                          setPickedFile(file);
                        }}
                      >
                        {file.filename}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {focusedAction ? (
            <SuggestedPromptRow
              action={focusedAction}
              disabled={isThinking}
              onPick={setComposerMessage}
            />
          ) : null}
          {composerError ? (
            <div style={composerErrorStyle} role="status">
              {composerError}
            </div>
          ) : null}
          {pickedFile && !attachedFile ? (
            <div style={attachedFileRowStyle}>
              <span style={attachedFileNameStyle}>From your library: {pickedFile.filename}</span>
              <button
                type="button"
                style={attachedFileRemoveStyle}
                onClick={() => setPickedFile(null)}
                disabled={isThinking}
              >
                Remove
              </button>
            </div>
          ) : null}
          {attachedFile ? (
            <div style={attachedFileRowStyle}>
              <span style={attachedFileNameStyle}>{attachedFile.name}</span>
              {/* The merchant's call, per upload. Default OFF: storing by default would turn
                  every casual screenshot into a retained record nobody chose to create.
                  ⛔ The label says what it DOES — kept so Jefe can look again — and never
                  implies privacy, because both answers send the file to a model to be read. */}
              <label style={keepFileLabelStyle}>
                <input
                  type="checkbox"
                  checked={keepFile}
                  onChange={(event) => setKeepFile(event.currentTarget.checked)}
                  disabled={isThinking}
                />
                Keep this file
              </label>
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
            {keepFile ? <input type="hidden" name="keepAttachment" value="true" /> : null}
            {/* A fresh upload wins if somehow both are set — the merchant just chose it. */}
            {pickedFile && !attachedFile ? (
              <input type="hidden" name="libraryFileId" value={pickedFile.id} />
            ) : null}
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
              required={!attachedFile && !pickedFile}
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
  const visibleSteps = focusedAction.displaySteps?.slice(0, 4) ?? [];
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
            <WorkflowStatusSummary
              action={focusedAction}
              stepCount={visibleSteps.length}
            />
            <span style={focusStripChevronStyle}>
              {focusExpanded ? "▲" : "▼"}
            </span>
          </span>
        </button>
      </div>
    </section>
  );
}

function FocusedActionLifecyclePanel({ action }: { action: MerchantActionView }) {
  const currentStep = normalizedCurrentStep(action);
  const proposed = action.status === "proposed";
  const completed = action.status === "completed";
  const steps = actionSteps(action);
  if (proposed) {
    return (
      <>
        <FocusedActionPlanBlock
          action={action}
          steps={steps}
          heading="THE PLAN"
          summary={action.summary ?? null}
        />
        <ActionContextDivider action={action} />
      </>
    );
  }

  if (completed) {
    return (
      <>
        <section style={currentStepPanelStyle("completed")} aria-label="Completed action">
          <div style={currentStepTopStyle}>
            <Mono>COMPLETED</Mono>
            <span style={currentStepBadgeGroupStyle}>
              <StatusPill tone="green">done</StatusPill>
            </span>
          </div>
          <h2 style={currentStepTitleStyle}>{action.title}</h2>
          <p style={currentStepDetailStyle}>
            {action.successText || action.currentSignal || "Jefe has finished this action."}
          </p>
        </section>
        <FocusedActionPlanBlock
          action={action}
          steps={steps}
          heading="THE PLAN"
          summary={action.currentSignal ?? action.successText ?? null}
        />
        <ActionContextDivider action={action} />
      </>
    );
  }

  if (!currentStep || typeof currentStep === "string") {
    return (
      <>
        <FocusedActionPlanBlock
          action={action}
          steps={steps}
          heading="THE PLAN"
          summary={action.currentSignal ?? action.summary ?? null}
        />
        <ActionContextDivider action={action} />
      </>
    );
  }

  const status = currentStep.status || "waiting";
  const mode = currentStep.mode || "";
  const attention = currentStep.attention && Object.keys(currentStep.attention).length
    ? currentStep.attention
    : null;
  const eyebrow =
    status === "running"
      ? mode === "execute"
        ? "JEFE IS WORKING"
        : "CURRENT STEP"
      : status === "needs_merchant"
        ? "YOUR NEXT STEP"
        : status === "needs_attention"
          ? "NEEDS ATTENTION"
          : "NEXT STEP";
  const tone =
    status === "needs_attention"
      ? "attention"
      : status === "running" || status === "ready"
        ? "ready"
        : "merchant";
  return (
    <>
      <section style={currentStepPanelStyle(tone)} aria-label="Current action step">
        <div style={currentStepTopStyle}>
          <Mono>{eyebrow}</Mono>
          <span style={currentStepBadgeGroupStyle}>
            <StatusPill tone={status === "running" || status === "completed" ? "green" : "yellow"}>
              {displayStepStatus(currentStep)}
            </StatusPill>
            <span style={ownerBadgeStyle(mode)}>
              {currentStepOwnerLabel(currentStep)}
            </span>
          </span>
        </div>
        <h2 style={currentStepTitleStyle}>{displayStepLabel(currentStep, 0)}</h2>
        <p style={currentStepDetailStyle}>
          {stepDetail(currentStep)}
        </p>
        {currentStep.statusReason ? (
          <p style={currentStepReasonStyle}>{currentStep.statusReason}</p>
        ) : null}
        {attention ? (
          <p style={currentStepAttentionStyle}>
            {attentionDetail(attention)}
          </p>
        ) : null}
        {currentStepProgressLine(currentStep, action) ? (
          <p style={currentStepProgressStyle}>
            <span style={currentStepDotStyle} />
            {currentStepProgressLine(currentStep, action)}
          </p>
        ) : null}
        {status === "ready" ? (
          <div style={currentStepActionRowStyle}>
            <Form method="post" style={inlineFormStyle} onSubmit={markApprovalSent}>
              <input type="hidden" name="intent" value="action.step.start" />
              <input type="hidden" name="actionId" value={action.id} />
              {currentStep.id ? (
                <input type="hidden" name="stepId" value={currentStep.id} />
              ) : null}
              <button type="submit" style={primaryButtonStyle}>
                {stepCta(currentStep)}
              </button>
            </Form>
            <span style={currentStepNoteStyle}>
              Or just tell me to go ahead in the chat.
            </span>
          </div>
        ) : status === "running" ? (
          <div style={currentStepActionRowStyle}>
            <button type="button" style={pauseButtonStyle} disabled>
              Pause
            </button>
            <span style={currentStepNoteStyle}>I&apos;ll tell you when this is done.</span>
          </div>
        ) : null}
      </section>
      <FocusedActionPlanBlock
        action={action}
        steps={steps}
        heading="THE PLAN"
        summary={action.currentSignal ?? action.summary ?? null}
      />
      <ActionContextDivider action={action} />
    </>
  );
}

function FocusedActionPlanBlock({
  action,
  steps,
  heading,
  summary,
}: {
  action: MerchantActionView;
  steps: WorkflowStepDisplay[];
  heading: string;
  summary?: string | null;
}) {
  if (steps.length === 0 && !summary) return null;
  const displaySteps = normalizedActionSteps(action, steps);
  return (
    <section style={chatPlanBlockStyle} aria-label="Action plan">
      <Mono>{heading}</Mono>
      <div style={chatPlanContentStyle}>
        {summary ? (
          <p style={chatPlanSummaryStyle}>{compactText(summary, 220)}</p>
        ) : null}
        {displaySteps.length > 0 ? (
          <WorkflowStepList
            steps={displaySteps}
            variant="focus"
            highlightedStepId={currentWorkflowStepId(action)}
          />
        ) : null}
      </div>
    </section>
  );
}

function ActionContextDivider({ action }: { action: MerchantActionView }) {
  return (
    <div style={actionContextDividerStyle}>
      <span style={actionContextLineStyle} />
      <span style={actionContextTextStyle}>Now working on: {action.title}</span>
      <span style={actionContextLineStyle} />
    </div>
  );
}

function WorkflowStatusSummary({
  action,
  stepCount,
}: {
  action: MerchantActionView;
  stepCount: number;
}) {
  const label = actionStatusLabel(action);
  const steps = actionSteps(action);
  const completed = completedStepCount(steps);
  const countLabel =
    action.status === "in_progress" && completed > 0 && steps.length > 0
      ? `${completed} of ${steps.length} done`
      : stepCount > 0
        ? `${stepCount} ${stepCount === 1 ? "step" : "steps"}`
        : null;
  return (
    <span style={workflowStatusSummaryStyle(action.status)}>
      <span>{label}</span>
      {countLabel ? <span>·</span> : null}
      {countLabel ? <span>{countLabel}</span> : null}
    </span>
  );
}

function actionStatusLabel(action: MerchantActionView) {
  if (action.status === "accepted") {
    const current = normalizedCurrentStep(action);
    if (current && typeof current !== "string" && current.status === "ready") {
      return "Ready to apply";
    }
  }
  return action.statusLabel || statusLabelForAction(action.status);
}

function actionSteps(action: MerchantActionView) {
  return action.displaySteps ?? action.workflow?.steps ?? [];
}

function completedStepCount(steps: WorkflowStepDisplay[]) {
  return steps.filter((step) => {
    if (typeof step === "string") return false;
    return step.done || ["completed", "skipped"].includes(String(step.status ?? ""));
  }).length;
}

function currentWorkflowStep(action: MerchantActionView) {
  const steps = normalizedActionSteps(action, actionSteps(action));
  return (
    steps.find((step) => {
      if (typeof step === "string") return false;
      return ["ready", "running", "needs_merchant", "needs_attention"].includes(
        String(step.status ?? ""),
      );
    }) ??
    steps.find((step) => {
      if (typeof step === "string") return false;
      return !step.done && step.status !== "completed";
    }) ??
    null
  );
}

function currentWorkflowStepId(action: MerchantActionView) {
  const current = normalizedCurrentStep(action);
  return current && typeof current !== "string" ? current.id ?? null : null;
}

function normalizedCurrentStep(action: MerchantActionView) {
  const current = action.currentStep ?? currentWorkflowStep(action);
  if (!current || typeof current === "string") return current;
  return normalizedActionSteps(action, [current])[0] ?? current;
}

function normalizedActionSteps(
  action: MerchantActionView,
  steps: WorkflowStepDisplay[],
) {
  if (action.status === "proposed") return steps;
  let unlocked = false;
  return steps.map((step) => {
    if (typeof step === "string") return step;
    const status = String(step.status ?? "");
    if (status !== "pending") return step;
    if (!unlocked && !step.done) {
      unlocked = true;
      return {
        ...step,
        status:
          step.mode === "merchant_action" || step.mode === "merchant"
            ? "needs_merchant"
            : "ready",
      };
    }
    return { ...step, status: "waiting" };
  });
}

function stepDetail(step: Exclude<WorkflowStepDisplay, string>) {
  return (
    step.description ||
    step.completionCriteria ||
    "Jefe will use the approved plan and current store state for this step."
  );
}

function stepCta(step: Exclude<WorkflowStepDisplay, string>) {
  const title = displayStepLabel(step, 0).toLowerCase();
  if (/apply|write|update/.test(title)) return "Apply changes";
  if (/review|approve/.test(title)) return "Review proposals";
  if (/measure|watch/.test(title)) return "Start watching";
  return "Do this step";
}

function attentionDetail(attention: Record<string, unknown>) {
  const skipped = Number(attention.skippedCount ?? 0);
  const refused = Number(attention.refusedCount ?? 0);
  if (skipped || refused) {
    return `${skipped + refused} item${skipped + refused === 1 ? "" : "s"} need review before Jefe can continue.`;
  }
  return String(attention.detail ?? "This step needs review before Jefe can continue.");
}

function currentStepProgressLine(
  step: Exclude<WorkflowStepDisplay, string>,
  action: MerchantActionView,
) {
  const progress = step.progress && typeof step.progress === "object" ? step.progress : {};
  for (const key of ["summary", "detail", "line", "message"]) {
    const value = progress[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return action.currentSignal ?? null;
}

function WorkflowStepList({
  steps,
  heading,
  variant,
  highlightedStepId,
}: {
  steps: WorkflowStepDisplay[];
  heading?: string;
  variant: "spotlight" | "focus";
  highlightedStepId?: string | null;
}) {
  return (
    <div style={workflowBlockStyle(variant)}>
      {heading ? <Mono>{heading}</Mono> : null}
      <div style={workflowRowsStyle}>
        {steps.map((step, index) => (
          <WorkflowStepRow
            key={`${displayStepLabel(step, index)}-${index}`}
            step={step}
            index={index}
            highlighted={
              Boolean(highlightedStepId) &&
              typeof step !== "string" &&
              step.id === highlightedStepId
            }
          />
        ))}
      </div>
    </div>
  );
}

function WorkflowStepRow({
  step,
  index,
  highlighted,
}: {
  step: WorkflowStepDisplay;
  index: number;
  highlighted?: boolean;
}) {
  const ownerBadge = workflowStepOwnerBadge(step);
  const description = displayStepDescription(step);
  const status = displayStepStatus(step);
  const normalizedStatus = typeof step === "string" ? "" : String(step.status ?? "");
  const isActive = highlighted || ["ready", "running", "needs_merchant", "needs_attention"].includes(normalizedStatus);
  return (
    <div style={workflowStepRowStyle(isActive)}>
      <span style={workflowStepNumberStyle}>{index + 1}.</span>
      <span style={workflowStepBodyStyle}>
        <span style={workflowStepTitleLineStyle}>
          {ownerBadge ? (
            <span style={workflowOwnerBadgeStyle(ownerBadge)}>
              {ownerBadge}
            </span>
          ) : null}
          <strong style={workflowStepTitleStyle}>
            {displayStepLabel(step, index)}
          </strong>
        </span>
        {description ? (
          <span style={workflowStepDescriptionStyle}>{description}</span>
        ) : null}
      </span>
      <span style={workflowStepStatusStyle(status)}>{status}</span>
    </div>
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
  // The words are the answer; the chart, when there is one, sits under them. Order matters:
  // a reader who stops at the paragraph has the whole answer.
  const chartSpec = (message.metadata as { chart?: unknown } | null | undefined)?.chart;
  return (
    <MessageRow from={message.role}>
      {message.content}
      {chartSpec ? <ReplyChart spec={chartSpec} /> : null}
    </MessageRow>
  );
}

function SuggestedPromptRow({
  action,
  disabled,
  onPick,
}: {
  action: MerchantActionView;
  disabled: boolean;
  onPick: (prompt: string) => void;
}) {
  const prompts = suggestedPromptsForAction(action);
  if (prompts.length === 0) return null;
  return (
    <div style={suggestedPromptRowStyle} aria-label="Suggested prompts">
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          style={suggestedPromptButtonStyle}
          onClick={() => onPick(prompt)}
          disabled={disabled}
        >
          {prompt}
        </button>
      ))}
    </div>
  );
}

function FocusedActionDecisionRow({
  action,
}: {
  action: MerchantActionView | null;
}) {
  if (!action || action.status !== "proposed") return null;
  return (
    <div style={decisionRowStyle}>
      <Form method="post" onSubmit={markApprovalSent}>
        <input type="hidden" name="intent" value="action.accept_plan" />
        <input type="hidden" name="actionId" value={action.id} />
        <button type="submit" style={approveButtonStyle}>
          Accept plan
        </button>
      </Form>
      {action.actionRunId ? (
        <Form method="post">
          <input type="hidden" name="intent" value="action.defer" />
          <input type="hidden" name="actionRunId" value={action.actionRunId} />
          <input type="hidden" name="reason" value="defer" />
          <button type="submit" style={quietDecisionButtonStyle}>
            Not right now
          </button>
        </Form>
      ) : null}
      {!action.executable && action.raise ? (
        <div style={instructPathStyle}>
          <span style={instructLeadStyle}>
            {action.raise.reason ??
              "This one needs your go-ahead before any step can start."}
          </span>
          <span style={instructDetailStyle}>
            {action.raise.detail ?? "Accepting the plan does not write to Shopify."}
          </span>
        </div>
      ) : null}
      <span style={decisionNoteStyle}>
        Accepting unlocks the steps. Nothing runs until you say so.
      </span>
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

function normalizeAttentionItems(
  items: MerchantAttentionItem[],
  actions: MerchantActionView[],
): MerchantAttentionItem[] {
  const normalized = items.map((candidate) => {
    const action =
      candidate.action ??
      actions.find((actionCandidate) => actionCandidate.id === candidate.actionId) ??
      null;
    return { ...candidate, action };
  });
  const deduped: MerchantAttentionItem[] = [];
  const seen = new Set<string>();
  for (const candidate of normalized) {
    const key = attentionIdentity(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function attentionIdentity(item: MerchantAttentionItem) {
  return (
    item.actionId ??
    item.actionRunId ??
    item.action?.title ??
    item.title ??
    item.attentionType
  );
}

function attentionLabel(attentionType: string) {
  if (attentionType === "STEP_READY") return "READY TO START";
  if (attentionType === "MERCHANT_INPUT_REQUIRED") return "NEEDS YOU";
  return "NEEDS ATTENTION";
}

function isWorkingAction(action: MerchantActionView) {
  return (
    action.status === "accepted" ||
    action.status === "in_progress" ||
    action.status === "needs_attention"
  );
}

function isCompletedAction(action: MerchantActionView) {
  return action.status === "completed";
}

function statusLabelForAction(status: string) {
  if (status === "needs_attention") return "Needs attention";
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

function displayStepLabel(step: WorkflowStepDisplay, index: number) {
  if (typeof step === "string" && step.trim()) return step.trim();
  if (typeof step === "object" && step?.title) return String(step.title);
  if (typeof step === "object" && step?.label) return String(step.label);
  return `Step ${index + 1}`;
}

function displayStepDescription(step: WorkflowStepDisplay) {
  if (typeof step === "string") return "";
  return step.description || step.completionCriteria || "";
}

function actionProgressState(action: MerchantActionView) {
  const steps = action.displaySteps ?? [];
  const currentStepIndex = currentStepIndexForAction(action);
  if (isMeasuringAction(action, currentStepIndex)) {
    return { label: "Measuring result", currentStepIndex };
  }
  if (currentStepIndex >= 0 && steps.length > 0) {
    const step = steps[currentStepIndex];
    const position = `Step ${currentStepIndex + 1} of ${steps.length}`;
    const state = currentStepStatusLabel(step);
    if (
      state === "Needs you" ||
      state === "Needs attention" ||
      state === "Jefe is working"
    ) {
      return { label: `${state} · ${position}`, currentStepIndex };
    }
    return { label: `${position} · ${state}`, currentStepIndex };
  }
  if (steps.length > 0 && steps.every(stepIsDone)) {
    return { label: "Completed", currentStepIndex };
  }
  if (action.status === "accepted") {
    return { label: "Ready to start", currentStepIndex };
  }
  return {
    label: action.statusLabel || statusLabelForAction(action.status),
    currentStepIndex,
  };
}

function progressBadgeLabel(
  action: MerchantActionView,
  visibleSteps: WorkflowStepDisplay[],
) {
  const steps = action.displaySteps ?? visibleSteps;
  if (steps.length === 0) {
    return action.statusLabel || statusLabelForAction(action.status);
  }
  const doneCount = steps.filter(stepIsDone).length;
  return `In progress · ${doneCount} of ${steps.length} done`;
}

function progressFooterText(action: MerchantActionView, currentStepIndex: number) {
  if (isMeasuringAction(action, currentStepIndex)) {
    return "Jefe is measuring the result";
  }
  const steps = action.displaySteps ?? [];
  const step = steps[currentStepIndex];
  if (step) {
    const label = displayStepLabel(step, currentStepIndex);
    const state = currentStepStatusLabel(step);
    if (state === "Needs you") return `Next: ${label} — needs you`;
    if (state === "Needs attention") return `Needs attention: ${label}`;
    if (state === "Jefe is working") return `Jefe is working on: ${label}`;
    return `Next: ${label}`;
  }
  if (action.summary) return compactText(action.summary, 140);
  return action.statusLabel || statusLabelForAction(action.status);
}

function currentStepIndexForAction(action: MerchantActionView) {
  const steps = action.displaySteps ?? [];
  return steps.findIndex((step) => !stepIsTerminal(step));
}

function isMeasuringAction(action: MerchantActionView, currentStepIndex: number) {
  const executionStatus = normalizeDisplayToken(action.executionStatus);
  const outcomeStatus = normalizeDisplayToken(action.outcomeStatus);
  return (
    currentStepIndex < 0 &&
    ["applied", "partially_applied"].includes(executionStatus) &&
    outcomeStatus !== "measured"
  );
}

function stepTreatment(
  step: WorkflowStepDisplay,
  index: number,
  currentStepIndex: number,
): StepTreatment {
  if (stepIsDone(step)) return "completed";
  if (index === currentStepIndex) return "current";
  return "future";
}

function stepIsTerminal(step: WorkflowStepDisplay) {
  const status = normalizeDisplayToken(typeof step === "string" ? "" : step.status);
  return ["completed", "skipped", "superseded"].includes(status) || stepIsDone(step);
}

function stepIsDone(step: WorkflowStepDisplay) {
  if (typeof step === "string") return false;
  return Boolean(step.done) || normalizeDisplayToken(step.status) === "completed";
}

function currentStepStatusLabel(step: WorkflowStepDisplay) {
  const status = normalizeDisplayToken(typeof step === "string" ? "" : step.status);
  const mode = normalizeDisplayToken(workflowStepMode(step));
  if (["blocked", "failed", "needs_attention"].includes(status)) {
    return "Needs attention";
  }
  if (
    status === "needs_merchant" ||
    ["merchant_action", "evidence_required"].includes(mode)
  ) {
    return "Needs you";
  }
  if (["running", "in_progress"].includes(status)) {
    return "Jefe is working";
  }
  if (["", "draft", "pending", "proposed", "ready"].includes(status)) {
    return "Ready";
  }
  return statusLabelForAction(status);
}

function inProgressStepStatusLabel(
  treatment: StepTreatment,
  step: WorkflowStepDisplay,
) {
  if (treatment === "completed") return "done";
  if (treatment === "future") return "waiting";
  const state = currentStepStatusLabel(step);
  if (state === "Needs you") return "needs you";
  if (state === "Needs attention") return "needs attention";
  if (state === "Jefe is working") return "working";
  return state.toLowerCase();
}

function normalizeDisplayToken(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function displayStepStatus(step: WorkflowStepDisplay) {
  if (typeof step === "string") return "proposed";
  const status = step.status || (step.done ? "completed" : "proposed");
  if (status === "draft" || status === "proposed") {
    return "starts after acceptance";
  }
  if (status === "waiting") return "waiting";
  if (status === "completed") return "done";
  if (status === "needs_merchant") return "needs you";
  if (status === "needs_attention") return "needs attention";
  if (status === "running") return "working";
  return status.replace(/_/g, " ");
}

function workflowStepMode(step: WorkflowStepDisplay) {
  return typeof step === "string" ? "" : step.mode || "";
}

function workflowStepOwnerBadge(step: WorkflowStepDisplay) {
  switch (workflowStepMode(step)) {
    case "execute":
    case "assist":
      return "JEFE";
    case "evidence_required":
    case "merchant_action":
    case "merchant":
      return "MERCHANT";
    default:
      return "";
  }
}

function currentStepOwnerLabel(step: Exclude<WorkflowStepDisplay, string>) {
  switch (workflowStepMode(step)) {
    case "execute":
    case "assist":
    case "evidence_required":
      return "Jefe can do this";
    case "merchant_action":
    case "merchant":
      return "Needs you";
    default:
      return "Jefe can do this";
  }
}

function suggestedPromptsForAction(action: MerchantActionView) {
  const current = action.currentStep ?? currentWorkflowStep(action);
  const currentStatus =
    current && typeof current !== "string" ? String(current.status ?? "") : "";
  if (action.status === "proposed") {
    return [
      "Why are you doing this?",
      "Don't touch archived products",
      "What have you changed so far?",
    ];
  }
  if (currentStatus === "running" || action.status === "in_progress") {
    return ["Is it working?", "Go deeper on the rest?"];
  }
  if (currentStatus === "needs_merchant") {
    return ["What do you need from me?", "Show me the plan"];
  }
  if (currentStatus === "ready" || action.status === "accepted") {
    return ["Start this", "What will you change?"];
  }
  if (currentStatus === "needs_attention" || action.status === "needs_attention") {
    return ["What needs attention?", "How do we fix it?"];
  }
  if (action.status === "completed") {
    return ["What changed?", "What did it achieve?"];
  }
  return ["Show me the plan"];
}

function merchantActionFromPrimaryMove(
  move: PrimaryMove,
): MerchantActionView | null {
  if (move.state === "empty") return null;
  const displaySteps = move.workflowSteps.length
    ? move.workflowSteps.map((step) => ({
        id: step.id,
        label: step.title,
        description: step.description,
        completionCriteria: step.completionCriteria,
        status: step.status,
        mode: step.mode,
        capabilityRef: step.capabilityRef,
      }))
    : [
        move.whyThisAction,
        move.whyNow,
        move.successSignal ?? "",
      ].filter(Boolean);
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
    displaySteps,
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


/**
 * A chart Jefe drew, inside the reply that explains it.
 *
 * ⭐ Inline SVG, no client JS and no charting dependency: it renders in the first paint, works
 * in an embedded iframe, and cannot fail separately from the message it belongs to.
 *
 * ⛔ It is NEVER the answer. The reply text says everything on its own — the analyst is told not
 * to write "as shown below" — so a reader who cannot see this (an email client, a screen
 * reader, a failed render) loses nothing. Numbers here are already validated against the
 * computed analysis; see chartValuesAreGrounded.
 */
function ReplyChart({ spec }: { spec: unknown }) {
  const chart = layoutChart(spec);
  // A chart of no data is a lie with axes on it — layoutChart returns null and we draw nothing.
  if (!chart) return null;

  return (
    <figure style={chartFigureStyle}>
      {chart.title ? <figcaption style={chartTitleStyle}>{chart.title}</figcaption> : null}
      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        width="100%"
        role="img"
        aria-label={chartAltText(chart)}
        style={chartSvgStyle}
      >
        {chart.ticks.map((tick, index) => (
          <g key={`t${index}`}>
            <line
              x1={44}
              x2={chart.width - 12}
              y1={tick.y}
              y2={tick.y}
              stroke={COLORS.border}
              strokeWidth={1}
            />
            <text x={40} y={tick.y + 3} textAnchor="end" style={chartTickTextStyle}>
              {tick.value}
            </text>
          </g>
        ))}
        <line
          x1={44}
          x2={chart.width - 12}
          y1={chart.baselineY}
          y2={chart.baselineY}
          stroke={COLORS.muted}
          strokeWidth={1}
        />
        {chart.kind === "bar"
          ? chart.bars.map((bar, index) => (
              <g key={`b${index}`}>
                <rect
                  x={bar.x}
                  y={bar.y}
                  width={bar.width}
                  height={bar.height}
                  fill={COLORS.navy}
                  rx={2}
                />
                <text
                  x={bar.x + bar.width / 2}
                  y={chart.height - 10}
                  textAnchor="middle"
                  style={chartTickTextStyle}
                >
                  {bar.label}
                </text>
              </g>
            ))
          : (
              <>
                <polyline
                  fill="none"
                  stroke={COLORS.navy}
                  strokeWidth={2}
                  points={chart.points.map((p) => `${p.x},${p.y}`).join(" ")}
                />
                {chart.points.map((point, index) => (
                  <g key={`p${index}`}>
                    <circle cx={point.x} cy={point.y} r={3} fill={COLORS.navy} />
                    <text
                      x={point.x}
                      y={chart.height - 10}
                      textAnchor="middle"
                      style={chartTickTextStyle}
                    >
                      {point.label}
                    </text>
                  </g>
                ))}
              </>
            )}
      </svg>
    </figure>
  );
}

/** Screen readers get the numbers, not "chart". */
function chartAltText(chart: ReturnType<typeof layoutChart>): string {
  if (!chart) return "";
  const items = chart.kind === "bar" ? chart.bars : chart.points;
  const described = items.map((item) => `${item.label} ${item.value}`).join(", ");
  return chart.title ? `${chart.title}: ${described}` : described;
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

export type LibraryPick = { id: string; filename: string; kind: string };

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
      if (typeof window === "undefined" || typeof document === "undefined") {
        transcript.scrollTop = transcript.scrollHeight;
        return;
      }
      window.scrollTo({ top: document.documentElement.scrollHeight });
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

function Mono({ children }: { children: ReactNode }) {
  return <span style={monoStyle}>{children}</span>;
}

function StatusPill({
  tone,
  children,
}: {
  tone: "green" | "yellow";
  children: ReactNode;
}) {
  return <span style={statusPillStyle(tone)}>{children}</span>;
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
      workflowSteps: [],
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
      workflowSteps: workflowStepsFromSource(source, input.recommendation),
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
    workflowSteps: workflowStepsFromSource(source, input.recommendation),
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
    workflow: recommendation.workflow ?? null,
  };
}

function workflowStepsFromSource(
  source: { workflow?: RecommendationWorkflow | null } | null | undefined,
  recommendation: Recommendation,
): WorkflowStep[] {
  const steps = source?.workflow?.steps ?? recommendation?.workflow?.steps ?? [];
  return steps.map((step) => ({
    id: step.id,
    title: step.title,
    description: step.description,
    completionCriteria: step.completionCriteria ?? null,
    status: step.status,
    mode: step.mode,
    capabilityRef: step.capabilityRef ?? null,
  }));
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
  minHeight: "100vh",
  overflowX: "hidden",
  padding: "48px 24px 0",
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
  display: "flex",
  flexDirection: "column",
  gap: 0,
  maxWidth: 760,
  margin: "0 auto",
  minHeight: "calc(100vh - 48px)",
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
function statusPillStyle(tone: "green" | "yellow"): CSSProperties {
  const green = tone === "green";
  return {
    background: green ? COLORS.greenWash : "#fff7cc",
    border: `1px solid ${green ? COLORS.greenBorder : "#ead273"}`,
    borderRadius: 999,
    color: green ? COLORS.green : "#806900",
    display: "inline-flex",
    fontFamily: FONT.mono,
    fontSize: 12,
    fontWeight: 700,
    lineHeight: 1,
    padding: "6px 9px",
    whiteSpace: "nowrap",
  };
}
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
  gap: 20,
};
const spotlightTopStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 18,
  justifyContent: "space-between",
};
const spotlightMetaGroupStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  justifyContent: "flex-end",
};
const focusCarouselStyle: CSSProperties = {
  alignItems: "center",
  display: "inline-flex",
  gap: 6,
};
const focusArrowButtonStyle: CSSProperties = {
  alignItems: "center",
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  color: COLORS.navy,
  cursor: "pointer",
  display: "inline-flex",
  fontFamily: FONT.sans,
  fontSize: 18,
  fontWeight: 750,
  height: 30,
  justifyContent: "center",
  lineHeight: 1,
  padding: 0,
  width: 30,
};
const focusCounterStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 11,
  fontWeight: 650,
  letterSpacing: 0,
  lineHeight: 1,
  minWidth: 36,
  textAlign: "center",
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
const inProgressCardStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 16,
  display: "flex",
  flexDirection: "column",
  gap: 22,
  padding: "24px 24px 18px",
};
const proposedCardStyle: CSSProperties = {
  ...inProgressCardStyle,
  gap: 20,
};
const inProgressHeaderStyle: CSSProperties = {
  alignItems: "flex-start",
  display: "flex",
  gap: 18,
  justifyContent: "space-between",
};
const inProgressTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontSize: 20,
  fontWeight: 800,
  lineHeight: 1.2,
  margin: 0,
  minWidth: 0,
};
const inProgressBadgeStyle: CSSProperties = {
  alignItems: "center",
  background: COLORS.greenWash,
  border: `1px solid ${COLORS.greenBorder}`,
  borderRadius: 10,
  color: COLORS.green,
  display: "inline-flex",
  flex: "0 0 auto",
  fontFamily: FONT.mono,
  fontSize: 13,
  fontWeight: 700,
  gap: 8,
  lineHeight: 1.2,
  padding: "7px 12px",
  whiteSpace: "nowrap",
};
const inProgressBadgeDotStyle: CSSProperties = {
  background: "currentColor",
  borderRadius: 999,
  height: 7,
  width: 7,
};
const proposedBadgeStyle: CSSProperties = {
  alignItems: "center",
  background: COLORS.yellow,
  border: `1px solid ${COLORS.yellow}`,
  borderRadius: 10,
  color: "#0f1f36",
  display: "inline-flex",
  flex: "0 0 auto",
  fontSize: 15,
  fontWeight: 800,
  gap: 10,
  lineHeight: 1.2,
  padding: "10px 16px",
  whiteSpace: "nowrap",
};
const proposedBadgeDotStyle: CSSProperties = {
  background: "currentColor",
  borderRadius: 999,
  height: 7,
  width: 7,
};
const proposedSummaryStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 17,
  lineHeight: 1.45,
  margin: 0,
};
const inProgressStepsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
};
function inProgressStepRowStyle(treatment: StepTreatment): CSSProperties {
  const current = treatment === "current";
  return {
    alignItems: "center",
    color: current ? COLORS.ink : COLORS.meta,
    display: "grid",
    gap: "10px 14px",
    gridTemplateColumns: "38px max-content minmax(0, 1fr) max-content",
    lineHeight: 1.25,
    opacity: treatment === "future" ? 0.82 : 1,
  };
}
const inProgressStepNumberStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 14,
  fontWeight: 700,
  lineHeight: "24px",
};
function inProgressOwnerBadgeStyle(
  owner: string,
  treatment: StepTreatment,
): CSSProperties {
  if (treatment === "completed") {
    return {
      ...workflowOwnerBadgeStyle(owner),
      background: COLORS.card,
      borderColor: COLORS.hairline,
      color: COLORS.meta,
    };
  }
  return workflowOwnerBadgeStyle(owner);
}
function inProgressStepTitleStyle(treatment: StepTreatment): CSSProperties {
  return {
    color: treatment === "current" ? COLORS.ink : "inherit",
    fontSize: 17,
    fontWeight: treatment === "current" ? 750 : 500,
    minWidth: 0,
  };
}
function inProgressStepStatusStyle(
  treatment: StepTreatment,
  step: WorkflowStepDisplay,
): CSSProperties {
  const state = inProgressStepStatusLabel(treatment, step);
  const color =
    state === "done"
      ? COLORS.greenBorder
      : state === "needs you"
        ? "#7a5a08"
        : state === "working"
          ? COLORS.navy
          : COLORS.meta;
  return {
    color,
    fontFamily: FONT.mono,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: 0,
    lineHeight: 1.25,
    textAlign: "right",
    whiteSpace: "nowrap",
  };
}
const inProgressFooterStyle: CSSProperties = {
  alignItems: "center",
  borderTop: `1px solid ${COLORS.hairline}`,
  display: "flex",
  flexWrap: "wrap",
  gap: 14,
  justifyContent: "space-between",
  paddingTop: 18,
};
const proposedFooterStyle: CSSProperties = {
  ...inProgressFooterStyle,
  minHeight: 38,
};
const proposedSignalLineStyle: CSSProperties = {
  alignItems: "center",
  color: COLORS.meta,
  display: "flex",
  flexWrap: "wrap",
  fontSize: 14,
  gap: 8,
};
const inProgressFooterTextStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 16,
  lineHeight: 1.35,
  minWidth: 0,
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
  alignItems: "center",
  display: "flex",
  flex: "1 1 auto",
  flexWrap: "wrap",
  gap: "4px 16px",
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
  fontSize: 16,
  fontWeight: 750,
  lineHeight: 1.25,
  minWidth: 0,
};
const focusStripChevronStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 12,
  lineHeight: 1,
};

function currentStepPanelStyle(
  tone: "ready" | "merchant" | "attention" | "completed",
): CSSProperties {
  const border =
    tone === "attention"
      ? "#eccfc2"
      : tone === "completed"
        ? COLORS.greenBorder
        : COLORS.border;
  const accent =
    tone === "attention"
      ? "#a2532c"
      : tone === "merchant"
        ? "#d4a51c"
        : tone === "completed"
          ? COLORS.green
          : COLORS.navy;
  return {
    background: COLORS.card,
    border: `1px solid ${border}`,
    borderLeft: `4px solid ${accent}`,
    borderRadius: 12,
    boxShadow: "0 16px 42px rgba(39,55,77,0.08), 0 1px 2px rgba(39,55,77,0.06)",
    display: "flex",
    flexDirection: "column",
    gap: 16,
    margin: "0 0 22px",
    padding: "clamp(24px, 3.5vw, 34px)",
  };
}
const currentStepTopStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 12,
  justifyContent: "space-between",
};
const currentStepBadgeGroupStyle: CSSProperties = {
  alignItems: "center",
  display: "inline-flex",
  flexWrap: "wrap",
  gap: 8,
  justifyContent: "flex-end",
};
const currentStepTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontFamily: FONT.serif,
  fontSize: 28,
  fontWeight: 500,
  lineHeight: 1.22,
  margin: 0,
};
const currentStepDetailStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 16,
  lineHeight: 1.55,
  margin: 0,
  maxWidth: "62ch",
};
const currentStepReasonStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 14,
  lineHeight: 1.45,
  margin: "-4px 0 0",
};
const currentStepAttentionStyle: CSSProperties = {
  background: "#fdf4f0",
  border: "1px solid #eccfc2",
  borderRadius: 8,
  color: "#8a3f22",
  fontSize: 14,
  fontWeight: 650,
  lineHeight: 1.45,
  margin: 0,
  padding: "10px 12px",
};
const currentStepProgressStyle: CSSProperties = {
  alignItems: "center",
  color: COLORS.navy,
  display: "inline-flex",
  fontFamily: FONT.mono,
  fontSize: 14,
  fontWeight: 700,
  gap: 12,
  lineHeight: 1.4,
  margin: 0,
};
const currentStepDotStyle: CSSProperties = {
  background: "#b8c2cf",
  borderRadius: 999,
  display: "inline-block",
  height: 8,
  width: 8,
};
const currentStepActionRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
};
const currentStepNoteStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 13,
  lineHeight: 1.4,
  margin: 0,
};
const pauseButtonStyle: CSSProperties = {
  background: "transparent",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  color: COLORS.muted,
  cursor: "not-allowed",
  fontFamily: FONT.sans,
  fontSize: 14,
  fontWeight: 750,
  padding: "12px 22px",
};
const chatPlanBlockStyle: CSSProperties = {
  alignItems: "start",
  columnGap: 24,
  display: "grid",
  gridTemplateColumns: "56px minmax(0, 1fr)",
  margin: "0 0 26px",
};
const chatPlanContentStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  minWidth: 0,
};
const chatPlanSummaryStyle: CSSProperties = {
  color: "#9a9085",
  fontSize: 15,
  fontWeight: 600,
  lineHeight: 1.45,
  margin: 0,
};
const actionContextDividerStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 16,
  margin: "30px 0 24px",
};
const actionContextLineStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.hairline}`,
  flex: "1 1 auto",
  minWidth: 28,
};
const actionContextTextStyle: CSSProperties = {
  color: "#9a9085",
  flex: "0 1 auto",
  fontFamily: FONT.mono,
  fontSize: 12,
  fontWeight: 700,
  lineHeight: 1.35,
  textAlign: "center",
};

function workflowStatusSummaryStyle(status: string): CSSProperties {
  const active = status === "in_progress" || status === "completed" || status === "accepted";
  const attention = status === "needs_attention";
  return {
    alignItems: "center",
    color: attention ? "#a2532c" : active ? COLORS.green : "#9b7411",
    display: "inline-flex",
    fontFamily: FONT.mono,
    fontSize: 13,
    gap: 8,
    fontWeight: 700,
    lineHeight: 1.25,
    whiteSpace: "nowrap",
  };
}
function workflowBlockStyle(variant: "spotlight" | "focus"): CSSProperties {
  return {
    borderTop: variant === "spotlight" ? `1px solid ${COLORS.hairline}` : 0,
    display: "flex",
    flexDirection: "column",
    gap: variant === "spotlight" ? 18 : 0,
    paddingTop: variant === "spotlight" ? 22 : 0,
  };
}
const workflowRowsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
};
function workflowStepRowStyle(highlighted: boolean): CSSProperties {
  return {
    alignItems: "start",
    background: highlighted ? "#f6f3ee" : "transparent",
    borderRadius: 8,
    columnGap: 12,
    display: "grid",
    gridTemplateColumns: "42px minmax(0, 1fr) minmax(78px, max-content)",
    margin: highlighted ? "0 -8px" : 0,
    padding: highlighted ? "10px 8px" : "0 8px 0 0",
  };
}
const workflowStepNumberStyle: CSSProperties = {
  color: COLORS.meta,
  fontFamily: FONT.mono,
  fontSize: 11,
  fontWeight: 600,
  lineHeight: "24px",
};
const workflowStepBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 7,
  minWidth: 0,
};
const workflowStepTitleLineStyle: CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  flexWrap: "wrap",
  gap: "7px 12px",
  minWidth: 0,
};
const workflowStepTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontSize: 15,
  fontWeight: 800,
  lineHeight: 1.25,
};
function workflowOwnerBadgeStyle(owner: string): CSSProperties {
  const merchant = owner === "MERCHANT";
  return {
    background: merchant ? "#fff4cf" : "#e9f2ff",
    border: `1px solid ${merchant ? "#f3cf6b" : "#bdd4f2"}`,
    borderRadius: 6,
    color: merchant ? "#7b5a07" : COLORS.navy,
    fontFamily: FONT.mono,
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: 0,
    lineHeight: 1,
    padding: "5px 8px 4px",
    whiteSpace: "nowrap",
  };
}
function ownerBadgeStyle(mode: string): CSSProperties {
  const merchant = mode === "merchant_action" || mode === "merchant";
  return {
    background: merchant ? "#fff8df" : "#eef5ff",
    border: `1px solid ${merchant ? "#edd58b" : "#bfd3ec"}`,
    borderRadius: 6,
    color: merchant ? "#7b5a07" : COLORS.navy,
    display: "inline-flex",
    fontSize: 12,
    fontWeight: 800,
    justifyContent: "center",
    lineHeight: 1.2,
    minWidth: 86,
    padding: "5px 9px",
    textAlign: "center",
    whiteSpace: "nowrap",
  };
}
const workflowStepDescriptionStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 13,
  lineHeight: 1.35,
};
function workflowStepStatusStyle(status: string): CSSProperties {
  const normalized = status.toLowerCase();
  const green = normalized === "done" || normalized === "completed";
  const active = normalized === "working" || normalized === "ready";
  const attention = normalized.includes("attention") || normalized.includes("you");
  return {
    color: green
      ? COLORS.greenBorder
      : active
        ? COLORS.navy
        : attention
          ? "#a2532c"
          : "#9a9085",
    fontFamily: FONT.mono,
    fontSize: 12,
    fontWeight: 700,
    lineHeight: "26px",
    textAlign: "right",
    textTransform: "lowercase",
    whiteSpace: "nowrap",
  };
}
const messagesStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: "34px 4px 42px 0",
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
  background: COLORS.page,
  bottom: 0,
  marginTop: "auto",
  padding: "0 0 28px",
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
const chartFigureStyle: CSSProperties = {
  margin: "10px 0 2px",
  maxWidth: "100%",
};
const chartTitleStyle: CSSProperties = {
  color: COLORS.muted,
  fontFamily: FONT.mono,
  fontSize: 11,
  letterSpacing: "0.06em",
  marginBottom: 6,
  textTransform: "uppercase",
};
const chartSvgStyle: CSSProperties = { display: "block", height: "auto", maxWidth: "100%" };
const chartTickTextStyle: CSSProperties = {
  fill: COLORS.muted,
  fontFamily: FONT.mono,
  fontSize: 9,
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
const libraryPickSectionStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.border}`,
  marginTop: 12,
  paddingTop: 12,
};
const libraryPickListStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginTop: 8,
};
const libraryPickButtonStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 999,
  color: COLORS.navy,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 12,
  maxWidth: "100%",
  overflow: "hidden",
  padding: "5px 12px",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const keepFileLabelStyle: CSSProperties = {
  alignItems: "center",
  color: COLORS.muted,
  cursor: "pointer",
  display: "inline-flex",
  fontFamily: FONT.sans,
  fontSize: 12,
  gap: 5,
  whiteSpace: "nowrap",
};
const composerErrorStyle: CSSProperties = {
  color: COLORS.navy,
  fontFamily: FONT.sans,
  fontSize: 13,
  marginBottom: 8,
};
const suggestedPromptRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  marginBottom: 12,
};
const suggestedPromptButtonStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 999,
  color: COLORS.body,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 14,
  fontWeight: 700,
  lineHeight: 1.2,
  padding: "10px 17px",
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
  flexWrap: "wrap",
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
const decisionNoteStyle: CSSProperties = {
  color: "#9a9085",
  flex: "1 1 280px",
  fontSize: 14,
  fontWeight: 650,
  lineHeight: 1.35,
};
