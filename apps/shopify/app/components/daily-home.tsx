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
  Spinner,
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
    createdAt?: string | null;
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

type HomeProposalGenerationState = {
  canGenerate: boolean;
  reason: string | null;
  generatedToday: number;
  remaining: number;
  cap: number;
  isGenerating: boolean;
  hasPriorProposal: boolean;
  terminalStatus?: string | null;
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
      workState?: string | null;
      workStale?: boolean | null;
      blockers?: Array<{ type?: string; reason?: string | null }> | null;
      done?: boolean | null;
      statusLabel?: string | null;
      intendedActor?: string | null;
      approvalRequired?: boolean | null;
      itemKind?: string | null;
      workspaceState?: string | null;
      suppressStatus?: boolean | null;
      isMilestone?: boolean | null;
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
  executionStatus?: string | null;
  outcomeStatus?: string | null;
  raise?: { reason: string; detail: string | null } | null;
  progress?: Record<string, unknown> | null;
  currentStep?: WorkflowStepDisplay | null;
  workflow?: { steps?: WorkflowStepDisplay[] | null } | null;
  displaySteps?: WorkflowStepDisplay[];
  workspace?: {
    kind?: string | null;
    actionState?: string | null;
    currentFocus?: ActionWorkspaceFocus | null;
  } | null;
  currentFocus?: ActionWorkspaceFocus | null;
  actionState?: string | null;
  workProjection?: {
    work?: Array<{ step?: { id?: string | null }; state?: string; stale?: boolean }>;
    nextUsefulWork?: { step?: { id?: string | null }; state?: string } | null;
    artifacts?: Array<{
      stepId?: string | null;
      title?: string | null;
      artifactType?: string | null;
      stale?: boolean;
      current?: boolean;
    }> | null;
    planSchema?: unknown;
  } | null;
  successText?: string | null;
  baselineSignal?: string | null;
  currentSignal?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
  display?: ActionDisplayContract | null;
};

type ActionWorkspaceFocus = {
  kind?: string | null;
  eyebrow?: string | null;
  headline?: string | null;
  reason?: string | null;
  stepId?: string | null;
  itemKind?: string | null;
};

// The one canonical merchant-facing Action state projection, from
// app/lib/actions/action-display-state.server.js. Home and Action Chat read
// this exclusively — never action.status/workspace/currentFocus/currentStep
// directly. See that module for the derivation and the full contract shape.
type ActionDisplayState =
  | "proposed"
  | "ready"
  | "working"
  | "needs_you"
  | "done"
  | "stopped"
  | "couldnt_complete";

type LifecycleEvent = {
  id: string | null;
  type: string | null;
  label: string;
  occurredAt: string | null;
  detail?: string | null;
};

type RealWorldProgressStage = {
  id: string;
  label: string;
  status: "done" | "current" | "upcoming";
  occurredAt?: string | null;
};

type ComposerChip = {
  id: string;
  label: string;
  kind: "command" | "prefill" | "answer";
  intent?: string | null;
  prefillText?: string | null;
};

type ActionDisplayContract = {
  displayState: ActionDisplayState;
  title: string;
  subtitle: string;
  requiresMerchantInput: boolean;
  canExecute: boolean;
  canStop: boolean;
  startedAt: string | null;
  completedAt: string | null;
  lifecycleEvents: LifecycleEvent[];
  realWorldProgress: RealWorldProgressStage[];
  chips: ComposerChip[];
  ctaLabel: string | null;
  ctaIntent: string | null;
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
  homeProposalGeneration?: HomeProposalGenerationState | null;
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
  const homeConversations = props.conversation?.conversations ?? [];
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
    setStartActionChatError(null);

    if (!forceNew) {
      const knownChats =
        actionChatsCache[actionId] ??
        chatsFocusedOnActionFromHome(actionId, homeConversations);
      if (knownChats?.length === 1 && knownChats[0]?.id) {
        navigate(
          searchWith(location.search, {
            conversation: knownChats[0].id,
            talkAction: null,
          }),
          { preventScrollReset: true },
        );
        return;
      }
      if (knownChats && knownChats.length > 1) {
        setActionChatsCache((cache) => ({ ...cache, [actionId]: knownChats }));
        navigate(
          searchWith(location.search, {
            conversation: null,
            talkAction: actionId,
          }),
          { preventScrollReset: true },
        );
        return;
      }
    }

    setPendingTalkActionId(actionId);
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
          merchantActions={merchantActions}
          attentionItems={props.attentionItems ?? []}
          proposedActions={props.proposedActions ?? []}
          inProgressActions={props.inProgressActions ?? []}
          completedActions={props.completedActions ?? []}
          talkActionId={talkActionId}
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
          homeProposalGeneration={props.homeProposalGeneration ?? null}
        />
        {/* No footer link. Merchant Memory is reached from the shell gear →
            Settings → "What Jefe knows" (see surface-reachability tests);
            the chat log itself stays clean. */}
      </div>
    </main>
  );
}

function chatsFocusedOnActionFromHome(
  actionId: string,
  conversations: ChatConversation[],
): FocusedActionChatChoice[] | null {
  const matches = conversations
    .filter((chat) => chat.focusedActionId === actionId)
    .map((chat) => ({
      id: chat.id,
      title: chat.title,
      messageCount: chat.messageCount ?? 0,
      lastMessageAt: chat.lastMessageAt ?? null,
      createdAt: chat.createdAt ?? null,
    }));
  return matches.length > 0 ? matches : null;
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
  merchantActions,
  talkActionId,
  focusedActionChats,
  focusedActionChatsLoading,
  focusedActionChatError,
  startingActionId,
  onStartFocusedChat,
  onCloseTalkAction,
  currentSearch,
  storeTimeZone,
  homeProposalGeneration,
}: {
  merchantActions: MerchantActionView[];
  // Still accepted for backward compatibility with the loader, which still
  // computes them — Home no longer reads them. action.display.displayState
  // (app/lib/actions/action-display-state.server.js) is the sole frontend
  // state contract now; see that module for how it derives from the
  // underlying recommendation/execution/workflow state these arrays used to
  // approximate.
  attentionItems?: MerchantAttentionItem[];
  proposedActions?: MerchantActionView[];
  inProgressActions?: MerchantActionView[];
  completedActions?: MerchantActionView[];
  talkActionId: string | null;
  focusedActionChats: FocusedActionChatChoice[];
  focusedActionChatsLoading?: boolean;
  focusedActionChatError?: string | null;
  startingActionId?: string | null;
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
  onCloseTalkAction: () => void;
  currentSearch: string;
  storeTimeZone?: string | null;
  homeProposalGeneration?: HomeProposalGenerationState | null;
}) {
  const navigation = useNavigation();
  const isSubmittingGeneration =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "home.generate_proposal";

  const needsYou = merchantActions
    .filter((action) => action.display?.displayState === "needs_you")
    .sort(byRecentlyUpdated);
  // Home has no separate "Proposed" shelf per the supplied mockups — a
  // never-reviewed proposal and an accepted-but-not-started action sit in
  // the same "come look and run it" position. Each card still shows its own
  // true state as its pill (see ActionStatePill).
  const readyOrProposed = merchantActions
    .filter((action) =>
      action.display?.displayState === "ready" || action.display?.displayState === "proposed",
    )
    .sort(byRecentlyUpdated);
  const working = merchantActions
    .filter((action) => action.display?.displayState === "working")
    .sort(byRecentlyUpdated);
  const recent = merchantActions
    .filter((action) =>
      ["done", "stopped", "couldnt_complete"].includes(action.display?.displayState ?? ""),
    )
    .sort(byRecentlyUpdated);
  const activeActions = [...needsYou, ...readyOrProposed, ...working];
  const talkAction = talkActionId
    ? merchantActions.find((action) => action.id === talkActionId) ?? null
    : null;

  return (
    <>
      <section style={homeHeroStyle} aria-label="Next actions">
        <h1 style={headlineStyle}>
          Here&apos;s what I&apos;d do <em style={headlineEmStyle}>next.</em>
        </h1>
        <p style={homeSummaryStyle}>
          {homeSummarySentence({
            needsYouCount: needsYou.length,
            readyCount: readyOrProposed.length,
            workingCount: working.length,
          })}
        </p>
        {activeActions.length > 0 ? (
          <div style={actionListStyle}>
            {activeActions.slice(0, 8).map((action) => (
              <ActionCard
                key={action.id || action.title}
                action={action}
                onStartFocusedChat={onStartFocusedChat}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section aria-label="Recent">
        <div style={recentSectionHeaderStyle}>
          <Mono>RECENT</Mono>
          <span style={recentSectionRuleStyle} />
        </div>
        {recent.length > 0 ? (
          <div style={actionListStyle}>
            {recent.slice(0, 6).map((action) => (
              <ActionCard
                key={action.id || action.title}
                action={action}
                onStartFocusedChat={onStartFocusedChat}
                active={false}
              />
            ))}
          </div>
        ) : (
          <EmptySection
            title="Nothing recent yet"
            body="Completed and stopped actions will appear here."
          />
        )}
      </section>

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
      <FloatingGenerateProposalButton
        generation={homeProposalGeneration}
        isSubmitting={isSubmittingGeneration}
      />
    </>
  );
}

function byRecentlyUpdated(a: MerchantActionView, b: MerchantActionView) {
  return (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "");
}

// Generated from real counts, never hard-coded — matches the supplied
// mockup's "One action needs a decision from you. One is ready to run."
// exactly for that case, and degrades sensibly for every other mix.
function homeSummarySentence(counts: {
  needsYouCount: number;
  readyCount: number;
  workingCount: number;
}): string {
  const parts: string[] = [];
  if (counts.needsYouCount === 1) parts.push("One action needs a decision from you.");
  else if (counts.needsYouCount > 1)
    parts.push(`${counts.needsYouCount} actions need a decision from you.`);
  if (counts.readyCount === 1) parts.push("One is ready to run.");
  else if (counts.readyCount > 1) parts.push(`${counts.readyCount} are ready to run.`);
  if (parts.length === 0 && counts.workingCount === 1) parts.push("One action is in progress.");
  else if (parts.length === 0 && counts.workingCount > 1)
    parts.push(`${counts.workingCount} actions are in progress.`);
  if (parts.length === 0) parts.push("Nothing needs you right now.");
  return parts.join(" ");
}

// Persistent floating control, bottom-right — same fixed-position/pill
// visual language as the top-right Settings cog / "Open the app ↗" chrome
// in app.tsx. Proposal generation is available from anywhere on Home now,
// not just an empty-state hero card; the request/handler (intent
// "home.generate_proposal") and daily-limit gating are unchanged.
function FloatingGenerateProposalButton({
  generation,
  isSubmitting,
}: {
  generation: HomeProposalGenerationState | null | undefined;
  isSubmitting: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const isGenerating = isSubmitting || generation?.isGenerating === true;
  const canGenerate = generation?.canGenerate === true && !isGenerating;
  const buttonLabel = generation?.hasPriorProposal
    ? "Generate another proposal"
    : "Generate a proposal";
  // Kept visible for the duration of a generation in flight even after the
  // pointer leaves — hiding a button mid-submit while its own request is
  // still running would be confusing, not minimal.
  const revealed = hovered || isGenerating;
  return (
    <div
      style={floatingGenerateWrapStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Form method="post" style={floatingGenerateFormStyle(revealed)}>
        <input type="hidden" name="intent" value="home.generate_proposal" />
        <button
          type="submit"
          style={floatingGenerateButtonStyle(canGenerate)}
          disabled={!canGenerate}
          aria-busy={isGenerating}
        >
          {isGenerating ? (
            <>
              <Spinner size="small" accessibilityLabel="Generating proposal" hasFocusableParent />
              <span>Generating…</span>
            </>
          ) : (
            <span>{buttonLabel}</span>
          )}
        </button>
      </Form>
    </div>
  );
}

// One card shape for both active and Recent actions — title top-left,
// status pill top-right, subtitle below, contextual CTA bottom-right below
// a hairline divider. Recent cards are the exact same card, just less
// opaque (active=false), not a different row/link treatment — they still
// open into Action Chat the same way.
function ActionCard({
  action,
  onStartFocusedChat,
  active = true,
}: {
  action: MerchantActionView;
  onStartFocusedChat: (actionId: string, forceNew?: boolean) => void;
  active?: boolean;
}) {
  const display = action.display;
  const state = display?.displayState ?? "proposed";
  return (
    <article style={actionCardStyle(active)} aria-label={action.title}>
      <div style={inProgressHeaderStyle}>
        <h3 style={inProgressTitleStyle}>{action.title}</h3>
        <ActionStatePill state={state} />
      </div>
      {display?.subtitle ? (
        <p style={proposedSummaryStyle}>{display.subtitle}</p>
      ) : action.summary ? (
        <p style={proposedSummaryStyle}>{compactText(action.summary, 260)}</p>
      ) : (
        <p style={proposedSummaryStyle}>{statusLabelForAction(action.status)}</p>
      )}
      {display?.realWorldProgress && display.realWorldProgress.length > 0 ? (
        <RealWorldProgressTimeline stages={display.realWorldProgress} />
      ) : null}
      <div style={actionCardFooterStyle}>
        <button
          type="button"
          style={textButtonStyle}
          disabled={!action.id}
          onClick={() => onStartFocusedChat(action.id)}
        >
          {display?.ctaLabel ?? "Open →"}
        </button>
      </div>
    </article>
  );
}

const ACTION_STATE_PILL_META: Record<
  ActionDisplayState,
  { label: string; tone: "amber" | "navy" | "green" | "neutral" }
> = {
  proposed: { label: "Proposed", tone: "amber" },
  ready: { label: "Ready", tone: "navy" },
  working: { label: "Working", tone: "green" },
  needs_you: { label: "Needs you", tone: "amber" },
  done: { label: "Done", tone: "neutral" },
  stopped: { label: "Stopped", tone: "neutral" },
  couldnt_complete: { label: "Couldn't complete", tone: "neutral" },
};

function ActionStatePill({ state }: { state: ActionDisplayState }) {
  const meta = ACTION_STATE_PILL_META[state] ?? ACTION_STATE_PILL_META.proposed;
  return (
    <span style={actionStatePillStyle(meta.tone)}>
      <span style={actionStatePillDotStyle} />
      {meta.label}
    </span>
  );
}

// Compact horizontal timeline for genuine business stages (e.g. "Transfer
// raised · Stock arrives 2 Sep · Received · Back on sale"). Internal
// planning/milestone steps must never be sourced into this — it is populated
// only from real-world data the backend contract explicitly opts into.
function RealWorldProgressTimeline({
  stages,
}: {
  stages: RealWorldProgressStage[];
}) {
  return (
    <div style={realWorldProgressStyle} aria-label="Progress">
      {stages.map((stage, index) => (
        <span key={stage.id} style={realWorldProgressStageStyle(stage.status)}>
          {index > 0 ? <span style={realWorldProgressDividerStyle} aria-hidden="true" /> : null}
          {stage.label}
        </span>
      ))}
    </div>
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
  if (!loading && !error && chats.length === 1) return null;
  if (loading && chats.length <= 1) return null;
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
  const [pendingFocus, setPendingFocus] = useState<MerchantActionView | null>(
    null,
  );
  const activeConversation = conversation?.conversation ?? null;
  const messages = useMemo(
    () => visibleTranscriptMessages(conversation?.messages ?? []),
    [conversation?.messages],
  );
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

        {focusedAction ? (
          <ActionChatHeader action={focusedAction} />
        ) : (
          <ChatTitleBlock
            conversation={activeConversation}
            messages={messages}
          />
        )}

        <div ref={transcriptRef} style={messagesStyle}>
          {isBlankThread && !pendingMessage ? <EmptyChat /> : null}
          {interleaveLifecycleEvents(messages, focusedAction?.display?.lifecycleEvents ?? []).map(
            (row) =>
              row.kind === "lifecycle" ? (
                <LifecycleDivider key={`event:${row.event.id ?? row.event.occurredAt}`} event={row.event} />
              ) : (
                <FocusedMessageRow key={row.message.id} message={row.message} />
              ),
          )}
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
            <ActionChatChips
              action={focusedAction}
              conversationId={activeConversation.id}
              disabled={isThinking}
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
                    ? composerPlaceholderForAction(focusedAction)
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
  messages,
}: {
  conversation: ChatConversation;
  messages: Array<{ role: string; content: string }>;
}) {
  const [headerHovered, setHeaderHovered] = useState(false);
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
  const canDownload = messages.length > 0;

  const finishTitleEdit = (nextTitle: string) => {
    if (nextTitle.trim() === displayTitle.trim()) return;
    const formData = new FormData();
    formData.set("intent", "chat.rename");
    formData.set("conversationId", conversation.id);
    formData.set("title", nextTitle);
    renameFetcher.submit(formData, { method: "post" });
  };

  return (
    <section
      style={chatTitleBlockStyle}
      onMouseEnter={() => setHeaderHovered(true)}
      onMouseLeave={() => setHeaderHovered(false)}
    >
      <div style={chatTitleHeaderRowStyle}>
        <Mono>CHAT</Mono>
        <button
          type="button"
          style={downloadTranscriptButtonStyle(headerHovered && canDownload)}
          onClick={() => downloadChatTranscript(displayTitle, messages)}
          disabled={!canDownload}
          aria-label="Download transcript"
          aria-hidden={!headerHovered || !canDownload}
          tabIndex={headerHovered && canDownload ? 0 : -1}
        >
          Download transcript
        </button>
      </div>
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

// Status label / title / subtitle only — no surrounding status card, no
// permanent plan panel. "How does this plan work?" and "Change something in
// the plan" stay 100% conversational; see ActionChatChips + the existing
// replanning machinery (ACTION_COMMAND.REPLAN_ACTION) for that.
function ActionChatHeader({ action }: { action: MerchantActionView }) {
  const display = action.display;
  const state = display?.displayState ?? "proposed";
  const meta = ACTION_STATE_PILL_META[state] ?? ACTION_STATE_PILL_META.proposed;
  return (
    <section style={actionChatHeaderStyle} aria-label="Action status">
      <span style={actionChatStatusLabelStyle(meta.tone)}>{meta.label.toUpperCase()}</span>
      <h1 style={actionChatTitleStyle}>{action.title}</h1>
      {display?.subtitle ? <p style={actionChatSubtitleStyle}>{display.subtitle}</p> : null}
      {/* No-dead-ends invariant: Jefe can propose anything, but only executes where a
          typed adapter exists. When it doesn't, say so and say what accepting even
          means here — never a silent "unavailable". */}
      {!action.executable && action.raise ? (
        <div style={instructPathStyle}>
          <span style={instructLeadStyle}>
            {action.raise.reason ?? "This one needs your go-ahead before any step can start."}
          </span>
          <span style={instructDetailStyle}>
            {action.raise.detail ?? "Accepting the plan does not write to Shopify."}
          </span>
        </div>
      ) : null}
    </section>
  );
}

// A subtle horizontal divider for a chat-visible lifecycle event (e.g. "PLAN
// UPDATED · 14:22"), reusing the same treatment already used for system
// messages. Only significant, merchant-relevant events reach here — see
// LIFECYCLE_EVENT_LABELS in action-display-state.server.js for the full set;
// implementation-noise (execution-loop iterations, verification turns,
// internal tool calls) never becomes a MerchantActionEvent in the first place.
function LifecycleDivider({ event }: { event: LifecycleEvent }) {
  return (
    <div style={systemEventStyle}>
      <span style={systemEventLineStyle} />
      <span style={systemEventTextStyle}>
        {event.label}
        {event.occurredAt ? ` · ${formatEventTime(event.occurredAt)}` : ""}
      </span>
      <span style={systemEventLineStyle} />
    </div>
  );
}

function formatEventTime(value: string) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

type TranscriptRow =
  | { kind: "message"; message: ChatThread["messages"][number] }
  | { kind: "lifecycle"; event: LifecycleEvent };

// Interleaves lifecycle events into the message transcript by timestamp, so
// e.g. "JEFE STARTED MAKING THE CHANGES" lands at the point it actually
// happened relative to the conversation, not just appended at the end.
function interleaveLifecycleEvents(
  messages: ChatThread["messages"],
  events: LifecycleEvent[],
): TranscriptRow[] {
  if (events.length === 0) return messages.map((message) => ({ kind: "message", message }));
  const sortedEvents = [...events]
    .filter((event) => event.occurredAt)
    .sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? ""));
  const rows: TranscriptRow[] = [];
  let eventIndex = 0;
  for (const message of messages) {
    const messageAt = message.createdAt;
    while (
      eventIndex < sortedEvents.length &&
      messageAt &&
      (sortedEvents[eventIndex].occurredAt ?? "") <= messageAt
    ) {
      rows.push({ kind: "lifecycle", event: sortedEvents[eventIndex] });
      eventIndex += 1;
    }
    rows.push({ kind: "message", message });
  }
  while (eventIndex < sortedEvents.length) {
    rows.push({ kind: "lifecycle", event: sortedEvents[eventIndex] });
    eventIndex += 1;
  }
  return rows;
}

// Contextual conversation chips, sourced entirely from action.display.chips
// (composerChipsFor in action-display-state.server.js) — a function of
// (current display state, latest conversation context), not a static
// per-state table. "command" chips submit a structured intent through the
// existing action-command pathway (accept_plan/stop_action); "prefill" and
// "answer" chips send directly as a chat message through the existing
// conversational path — one click, no separate control surface.
function ActionChatChips({
  action,
  conversationId,
  disabled,
}: {
  action: MerchantActionView;
  conversationId?: string | null;
  disabled: boolean;
}) {
  const chips = action.display?.chips ?? [];
  if (chips.length === 0) return null;
  return (
    <div style={suggestedPromptRowStyle} aria-label="Suggested actions">
      {chips.map((chip) =>
        chip.kind === "command" && chip.intent ? (
          <Form key={chip.id} method="post" style={inlineFormStyle} onSubmit={markApprovalSent}>
            <input type="hidden" name="intent" value={chip.intent} />
            <input type="hidden" name="actionId" value={action.id} />
            {conversationId ? (
              <input type="hidden" name="conversationId" value={conversationId} />
            ) : null}
            <button type="submit" style={suggestedPromptButtonStyle} disabled={disabled}>
              {chip.label}
            </button>
          </Form>
        ) : (
          <Form key={chip.id} method="post" style={inlineFormStyle}>
            <input type="hidden" name="intent" value="chat.message" />
            {conversationId ? (
              <input type="hidden" name="conversationId" value={conversationId} />
            ) : null}
            <input type="hidden" name="focusedActionId" value={action.id} />
            <input type="hidden" name="message" value={chip.prefillText ?? chip.label} />
            <button type="submit" style={suggestedPromptButtonStyle} disabled={disabled}>
              {chip.label}
            </button>
          </Form>
        ),
      )}
    </div>
  );
}

function composerPlaceholderForAction(action: MerchantActionView) {
  return action.display?.displayState === "needs_you"
    ? "Answer Jefe, or type your own answer..."
    : "Ask Jefe about this action...";
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

function transcriptRoleLabel(role: string) {
  if (role === "merchant" || role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  if (role === "reference") return "Reference";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function formatChatTranscriptMarkdown(
  title: string,
  messages: Array<{ role: string; content: string }>,
) {
  const exportedAt = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date());
  const lines = [`# ${title}`, "", `Exported ${exportedAt}`, ""];
  for (const message of messages) {
    lines.push(`## ${transcriptRoleLabel(message.role)}`, "", message.content.trim(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function transcriptDownloadFilename(title: string) {
  const base =
    title
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "chat";
  return `${base}.md`;
}

function downloadChatTranscript(
  title: string,
  messages: Array<{ role: string; content: string }>,
) {
  const markdown = formatChatTranscriptMarkdown(title, messages);
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = transcriptDownloadFilename(title);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function visibleTranscriptMessages(
  messages: Array<{ id: string; role: string; content: string }>,
) {
  const visible: typeof messages = [];
  let lastFocusEvent: string | null = null;
  for (const message of messages) {
    if (
      message.role === "system" &&
      message.content.startsWith("Now working on:")
    ) {
      if (message.content === lastFocusEvent) continue;
      lastFocusEvent = message.content;
    }
    visible.push(message);
  }
  return visible;
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
// (from Storefront shop.brand, cached in rawPayload), otherwise the store's initial in the navy
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
  padding: "38px 24px 96px",
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
  gap: 32,
  maxWidth: 640,
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
  fontSize: 48,
  lineHeight: 1.08,
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
  gap: 14,
};
const homeSummaryStyle: CSSProperties = {
  color: COLORS.meta,
  fontSize: 17,
  lineHeight: 1.5,
  margin: "0 0 8px",
  maxWidth: 620,
};
const recentSectionHeaderStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 14,
  marginBottom: 14,
};
const recentSectionRuleStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.hairline}`,
  flex: "1 1 auto",
};
// Same fixed bottom-right dock as the top-right Settings/Open-the-app
// chrome in app.tsx, but hidden until hovered — a docked corner control,
// not a persistent card competing with the Action list.
const floatingGenerateWrapStyle: CSSProperties = {
  bottom: 16,
  position: "fixed",
  right: 16,
  zIndex: 40,
};
function floatingGenerateFormStyle(revealed: boolean): CSSProperties {
  return {
    opacity: revealed ? 1 : 0,
    pointerEvents: revealed ? "auto" : "none",
    transition: "opacity 160ms ease",
  };
}
// Matches openAppButtonStyle/chromeBase in app.tsx exactly (same pill:
// #fffdfa fill, #d8d0c8 border, #1f3a63 text, 999px radius, 34px height) so
// the two floating controls read as one visual family, top-right and
// bottom-right.
function floatingGenerateButtonStyle(canGenerate: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: COLORS.card,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 999,
    boxShadow: "0 1px 2px rgba(31,41,51,0.06)",
    boxSizing: "border-box",
    color: COLORS.navy,
    cursor: canGenerate ? "pointer" : "not-allowed",
    display: "inline-flex",
    fontFamily: FONT.sans,
    fontSize: 13,
    fontWeight: 600,
    gap: 8,
    height: 34,
    justifyContent: "center",
    minWidth: 190,
    opacity: canGenerate ? 1 : 0.6,
    padding: "0 16px",
    whiteSpace: "nowrap",
  };
}
const actionListStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
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
const proposedSummaryStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 17,
  lineHeight: 1.45,
  margin: 0,
};
function actionCardStyle(active: boolean): CSSProperties {
  return {
    ...inProgressCardStyle,
    gap: 12,
    // Same white card either way — Recent is just less opaque, not a
    // different treatment.
    opacity: active ? 1 : 0.72,
    padding: "22px 22px 16px",
  };
}
const actionCardFooterStyle: CSSProperties = {
  borderTop: `1px solid ${COLORS.hairline}`,
  display: "flex",
  justifyContent: "flex-end",
  paddingTop: 12,
};
const ACTION_STATE_PILL_PALETTE: Record<
  "amber" | "navy" | "green" | "neutral",
  { bg: string; border: string; color: string }
> = {
  amber: { bg: COLORS.yellow, border: COLORS.yellow, color: "#0f1f36" },
  navy: { bg: "#eaf0fa", border: "#b9cbe6", color: COLORS.navy },
  green: { bg: COLORS.greenWash, border: COLORS.greenBorder, color: COLORS.green },
  neutral: { bg: "transparent", border: COLORS.border, color: COLORS.meta },
};
function actionStatePillStyle(tone: "amber" | "navy" | "green" | "neutral"): CSSProperties {
  const palette = ACTION_STATE_PILL_PALETTE[tone] ?? ACTION_STATE_PILL_PALETTE.neutral;
  return {
    alignItems: "center",
    background: palette.bg,
    border: `1px solid ${palette.border}`,
    borderRadius: 10,
    color: palette.color,
    display: "inline-flex",
    flex: "0 0 auto",
    fontFamily: FONT.mono,
    fontSize: 12,
    fontWeight: 700,
    gap: 7,
    letterSpacing: 0.2,
    lineHeight: 1.2,
    padding: "7px 12px",
    textTransform: "uppercase",
    whiteSpace: "nowrap",
  };
}
const actionStatePillDotStyle: CSSProperties = {
  background: "currentColor",
  borderRadius: 999,
  height: 7,
  width: 7,
};
const realWorldProgressStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};
function realWorldProgressStageStyle(status: "done" | "current" | "upcoming"): CSSProperties {
  return {
    alignItems: "center",
    color: status === "upcoming" ? COLORS.meta : status === "current" ? COLORS.navy : COLORS.body,
    display: "inline-flex",
    fontFamily: FONT.mono,
    fontSize: 11,
    fontWeight: status === "current" ? 800 : 650,
    gap: 8,
    letterSpacing: 0.2,
    lineHeight: 1.3,
    textTransform: "uppercase",
  };
}
const realWorldProgressDividerStyle: CSSProperties = {
  background: COLORS.border,
  height: 1,
  width: 14,
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
const actionChatHeaderStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "26px 0 10px",
};
function actionChatStatusLabelStyle(tone: "amber" | "navy" | "green" | "neutral"): CSSProperties {
  const palette = ACTION_STATE_PILL_PALETTE[tone] ?? ACTION_STATE_PILL_PALETTE.neutral;
  return {
    color: tone === "neutral" ? COLORS.meta : palette.color,
    fontFamily: FONT.mono,
    fontSize: 12,
    fontWeight: 800,
    letterSpacing: 1.2,
    lineHeight: 1.2,
    textTransform: "uppercase",
  };
}
const actionChatTitleStyle: CSSProperties = {
  color: COLORS.ink,
  fontFamily: FONT.serif,
  fontSize: 34,
  fontWeight: 500,
  lineHeight: 1.16,
  margin: 0,
};
const actionChatSubtitleStyle: CSSProperties = {
  color: COLORS.body,
  fontSize: 17,
  lineHeight: 1.5,
  margin: 0,
  maxWidth: 620,
};
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
const chatTitleHeaderRowStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "space-between",
  width: "100%",
};
function downloadTranscriptButtonStyle(visible: boolean): CSSProperties {
  return {
    background: "transparent",
    border: 0,
    color: COLORS.meta,
    cursor: visible ? "pointer" : "default",
    flex: "none",
    fontFamily: FONT.mono,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: 0,
    opacity: visible ? 1 : 0,
    padding: 0,
    pointerEvents: visible ? "auto" : "none",
    textDecoration: "underline",
    transition: "opacity 120ms ease",
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
