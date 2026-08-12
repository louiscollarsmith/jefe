import { useEffect, useRef, useState, type ReactNode } from "react";
import { Form, useFetcher, useNavigate, useRevalidator } from "react-router";
import {
  BlockStack,
  Box,
  Button,
  InlineStack,
  Text,
} from "@shopify/polaris";

const STAGES = ["connect", "context", "insight", "action"] as const;
const CONTEXT_OPTIONS = [
  { value: "revenue", label: "Grow revenue", echo: "revenue comes first" },
  { value: "profit", label: "Improve margin", echo: "margin comes first" },
  { value: "slow_inventory", label: "Move slow inventory", echo: "you want slow stock moving" },
  { value: "retention", label: "Increase repeat purchases", echo: "you want customers coming back" },
  { value: "jefe_read_first", label: "Not sure — tell me what you see", echo: "you wanted my read first" },
] as const;

type FastOnboardingProps = {
  storeName: string;
  experience: FastExperience;
};

type ContextOption = (typeof CONTEXT_OPTIONS)[number];
type EvidenceRow = { key: string; value: string; source: string };
type InsightView = {
  id: string;
  runId: string;
  headline: string;
  explanation: string;
  whyItMatters: string;
  confidence: string;
  caveat: string | null;
  evidence: EvidenceRow[];
};
type RecommendationView = {
  id: string;
  runId: string;
  title: string;
  summary: string;
  whyItMatters: string;
  whatIllDo: string;
  howWellKnow: string;
  successMeasure: string | null;
  reviewAt: string | null;
  status: string;
  outcomeStatus: string;
  executable: boolean;
  actionRunId: string | null;
  executionStatus: string | null;
  approvalLabel: string;
};
type FastExperience = {
  stage: string;
  bootstrapPhase: string;
  context: { value: string; label: string; echo: string } | null;
  insight: InsightView | null;
  recommendation: RecommendationView | null;
  queueItems: Array<{ id: string; title: string; status: string }>;
  failure: { type: string; message: string } | null;
  fullLearning: { state: string; label: string; detail: string };
  handoff: { id: string; token: string } | null;
  devToolsEnabled: boolean;
};
type FetcherResult = {
  ok?: boolean;
  handoffUrl?: string;
  mode?: string;
  reason?: string;
};

export function FastValueOnboarding({ storeName, experience }: FastOnboardingProps) {
  const revalidator = useRevalidator();
  const answerFetcher = useFetcher<FetcherResult>();
  const transitionFetcher = useFetcher<FetcherResult>();
  const alternativeFetcher = useFetcher<FetcherResult>();
  const approvalFetcher = useFetcher<FetcherResult>();
  const milestoneFetcher = useFetcher<FetcherResult>();
  const navigate = useNavigate();
  const [localContext, setLocalContext] = useState<ContextOption | null>(null);
  const [acknowledgementFinished, setAcknowledgementFinished] = useState(true);
  const [optimisticStage, setOptimisticStage] = useState<string | null>(null);
  const [learningOpen, setLearningOpen] = useState(false);
  const [alternativeMessage, setAlternativeMessage] = useState<string | null>(null);
  const recordedMilestones = useRef(new Set<string>());

  const awaitingResult =
    experience.stage === "connect" ||
    (experience.stage === "context" &&
      Boolean(experience.context) &&
      !experience.failure) ||
    alternativeFetcher.state !== "idle";
  useEffect(() => {
    if (!awaitingResult) return;
    let delay = 2200;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      revalidator.revalidate();
      delay = Math.min(Math.round(delay * 1.4), 9000);
      timer = setTimeout(poll, delay);
    };
    timer = setTimeout(poll, delay);
    return () => clearTimeout(timer);
  }, [awaitingResult, revalidator]);

  useEffect(() => {
    if (!localContext || acknowledgementFinished) return;
    const timer = setTimeout(() => setAcknowledgementFinished(true), 1700);
    return () => clearTimeout(timer);
  }, [acknowledgementFinished, localContext]);

  useEffect(() => {
    const data = approvalFetcher.data;
    if (!data?.ok || !data?.handoffUrl) return;
    const handoffUrl = data.handoffUrl;
    const timer = setTimeout(() => navigate(handoffUrl), 1300);
    return () => clearTimeout(timer);
  }, [approvalFetcher.data, navigate]);

  useEffect(() => {
    const insightId = experience.insight?.runId;
    const recommendationId = experience.recommendation?.id;
    const stage = experience.stage;
    const entries = [
      stage === "insight" && insightId ? ["first_insight_shown", insightId] : null,
      stage === "action" && recommendationId ? ["recommendation_shown", recommendationId] : null,
    ].filter(Boolean) as string[][];
    for (const [type, entityId] of entries) {
      const key = `${type}:${entityId}`;
      if (recordedMilestones.current.has(key)) continue;
      recordedMilestones.current.add(key);
      milestoneFetcher.submit(
        { intent: "onboarding.milestone", type, entityId },
        { method: "post" },
      );
    }
  }, [experience.insight?.runId, experience.recommendation?.id, experience.stage, milestoneFetcher]);

  useEffect(() => {
    const handoff = experience.handoff;
    if (experience.stage !== "app" || !handoff?.token) return;
    const key = `entered_app:${handoff.id}`;
    if (recordedMilestones.current.has(key)) return;
    recordedMilestones.current.add(key);
    milestoneFetcher.submit(
      { intent: "onboarding.milestone", type: "entered_app", token: handoff.token },
      { method: "post" },
    );
    const current = new URL(globalThis.location.href);
    current.searchParams.delete("handoff");
    globalThis.history.replaceState(globalThis.history.state, "", `${current.pathname}${current.search}${current.hash}`);
  }, [experience.handoff, experience.stage, milestoneFetcher]);

  const acknowledgementActive = Boolean(localContext) && !acknowledgementFinished;
  const stage = acknowledgementActive ? "context" : optimisticStage ?? experience.stage;
  const context = localContext ?? experience.context;
  const approvedMode = approvalFetcher.data?.ok && approvalFetcher.data.handoffUrl
    ? approvalFetcher.data.mode ?? "track"
    : null;
  const visibleAlternativeMessage = alternativeFetcher.data?.reason === "strongest_supported_finding"
    ? "This is the strongest finding the current evidence can support."
    : alternativeMessage;

  function answer(option: ContextOption) {
    if (answerFetcher.state !== "idle") return;
    setLocalContext(option);
    setAcknowledgementFinished(false);
    answerFetcher.submit(
      { intent: "onboarding.context.answer", value: option.value },
      { method: "post" },
    );
  }

  function continueToAction() {
    if (!experience.recommendation?.id) return;
    setOptimisticStage("action");
    transitionFetcher.submit(
      {
        intent: "onboarding.insight.continue",
        recommendationId: experience.recommendation.id,
      },
      { method: "post" },
    );
  }

  function showAlternative() {
    if (!experience.recommendation?.id || alternativeFetcher.state !== "idle") return;
    setAlternativeMessage("I’m checking the next finding this same evidence can support.");
    alternativeFetcher.submit(
      {
        intent: "onboarding.insight.alternative",
        recommendationId: experience.recommendation.id,
      },
      { method: "post" },
    );
  }

  function approve() {
    if (!experience.recommendation?.id || approvalFetcher.state !== "idle") return;
    approvalFetcher.submit(
      {
        intent: "onboarding.recommendation.approve",
        recommendationId: experience.recommendation.id,
      },
      { method: "post" },
    );
  }

  return (
    <main className={`jf-onboarding is-${stage}`}>
      <div className="jf-bg-grid" aria-hidden="true" />
      <div className="jf-bg-top" aria-hidden="true" />
      <div className="jf-bg-corner" aria-hidden="true" />

      <header>
      <Box paddingBlockStart="400" paddingBlockEnd="400" paddingInlineStart="600" paddingInlineEnd="600">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <JefeMark compact />
            <span className="jf-wordmark">jefe</span>
          </InlineStack>
          <span className="jf-app-menu" aria-label="More options">• • •</span>
        </InlineStack>
      </Box>
      </header>

      <nav>
      <Box paddingBlockStart="600" paddingInlineStart="800" paddingInlineEnd="800">
        <InlineStack align="space-between" blockAlign="center" gap="400" wrap>
          <div className="jf-stepper" aria-label="Onboarding progress">
            {STAGES.map((item) => {
              const currentIndex = stage === "app" ? STAGES.length : Math.max(0, STAGES.indexOf(stage as (typeof STAGES)[number]));
              const index = STAGES.indexOf(item);
              const state = index < currentIndex ? "done" : index === currentIndex ? "current" : "future";
              return (
                <span className={`jf-step is-${state}`} key={item} aria-current={state === "current" ? "step" : undefined}>
                  <span className="jf-step-dot" aria-hidden="true" />
                  {item}
                </span>
              );
            })}
          </div>
          {stage !== "app" ? (
            <Form method="post">
              <input type="hidden" name="intent" value="onboarding.skip" />
              <Button variant="plain" submit>Skip setup — go to Jefe →</Button>
            </Form>
          ) : null}
        </InlineStack>
      </Box>
      </nav>

      <Box as="section" paddingInlineStart="800" paddingInlineEnd="800" paddingBlockEnd="800">
        <div className="jf-content" aria-live="polite">
          {stage === "connect" ? (
            <ConnectScene storeName={storeName} phase={experience.bootstrapPhase} />
          ) : stage === "context" ? (
            <ContextScene
              context={context}
              answer={answer}
              failure={experience.failure}
              retrying={answerFetcher.state !== "idle"}
            />
          ) : stage === "insight" ? (
            <InsightScene
              insight={experience.insight}
              continueToAction={continueToAction}
              showAlternative={showAlternative}
              alternativeMessage={visibleAlternativeMessage}
              alternativeBusy={alternativeFetcher.state !== "idle"}
            />
          ) : stage === "action" ? (
            <ActionScene
              insight={experience.insight}
              recommendation={experience.recommendation}
              approvedMode={approvedMode}
              approve={approve}
            />
          ) : (
            <AppScene
              storeName={storeName}
              context={experience.context}
              recommendation={experience.recommendation}
              queueItems={experience.queueItems}
            />
          )}
        </div>
      </Box>

      <footer>
      <Box paddingInlineStart="800" paddingInlineEnd="800" paddingBlockEnd="600">
        <InlineStack align="space-between" blockAlign="end" gap="400" wrap>
          <div className="jf-footer-status">
            {stage !== "connect" ? (
              <BlockStack gap="200">
                    {learningOpen ? (
                      <div className="jf-learning-panel">
                        <BlockStack gap="300">
                          <Text as="p">{experience.fullLearning.detail}</Text>
                          {experience.fullLearning.state === "access_failure" ? (
                            <Button url="/auth/login">Reconnect Shopify</Button>
                          ) : experience.fullLearning.state === "failed" ? (
                            <Form method="post">
                              <input type="hidden" name="intent" value="onboarding.retry" />
                              <input type="hidden" name="target" value="full_learning" />
                              <Button submit>Retry background learning</Button>
                            </Form>
                          ) : null}
                        </BlockStack>
                      </div>
                    ) : null}
                <span className={`jf-learning-pill is-${experience.fullLearning.state}`}>
                  <span className="jf-learning-dot" aria-hidden="true" />
                  <Button variant="plain" onClick={() => setLearningOpen((open) => !open)} ariaExpanded={learningOpen}>
                    {experience.fullLearning.label}
                  </Button>
                </span>
              </BlockStack>
            ) : null}
          </div>
          {experience.devToolsEnabled ? (
            <div className="jf-dev-states" aria-label="Developer state navigation">
              {[...STAGES, "app"].map((item) => (
                <Button key={item} variant="plain" onClick={() => setOptimisticStage(item)}>{item}</Button>
              ))}
            </div>
          ) : null}
        </InlineStack>
      </Box>
      </footer>
    </main>
  );
}

function JefeMark({ compact = false }: { compact?: boolean }) {
  return <span className={`jf-mark ${compact ? "is-compact" : ""}`} aria-hidden="true"><span>J</span><i /></span>;
}

function ConnectScene({ storeName, phase }: { storeName: string; phase: string }) {
  const active = phaseIndex(phase);
  const rows = [
    "Shopify connected",
    "Reading your most recent orders",
    "Looking at what’s selling",
    "Checking where there may be an opportunity",
  ];
  return (
    <div className="jf-scene jf-connect-scene">
      <JefeMark />
      <div className="jf-display jf-connect-title">
        I’m getting my <em>first read</em> on {storeName}.
      </div>
      <Text as="p">Give me a moment with your recent trading. I’m looking for the first thing I’d change.</Text>
      <div className="jf-activity">
        {rows.map((label, index) => {
          const state = index < active ? "done" : index === active ? "active" : "pending";
          return <div className={`jf-activity-row is-${state}`} key={label}><span aria-hidden="true">{state === "done" ? "✓" : state === "active" ? "●" : "·"}</span><Text as="p">{label}</Text></div>;
        })}
      </div>
    </div>
  );
}

function ContextScene({
  context,
  answer,
  failure,
  retrying,
}: {
  context: { value: string; label: string; echo: string } | null;
  answer: (option: ContextOption) => void;
  failure: FastExperience["failure"];
  retrying: boolean;
}) {
  const readState = failure
    ? failure.type === "insufficient"
      ? "Recent read complete"
      : "Read paused"
    : "Still looking";
  return (
    <div className="jf-scene jf-context-scene">
      <Kicker pulse={!failure}>{readState}</Kicker>
      {!context ? (
        <>
          <div className="jf-display jf-context-title">While I finish looking — what matters most to you <em>right now</em>?</div>
          <Text as="p">One tap. It tells me which opportunity to bring you first.</Text>
          <BlockStack gap="200">
            {CONTEXT_OPTIONS.map((option) => (
              <div className="jf-option" key={option.value}>
                <Button fullWidth onClick={() => answer(option)} disabled={retrying}>{option.label} →</Button>
              </div>
            ))}
          </BlockStack>
        </>
      ) : failure ? (
        <div className="jf-ack">
          <span aria-hidden="true">✓</span>
          <span>Your priority is saved. I won’t force a recommendation the evidence can’t support.</span>
        </div>
      ) : (
        <div className="jf-ack"><span className="jf-pulse-dot" aria-hidden="true" /><span>Got it — {context.echo}. Let me finish the last check.</span></div>
      )}
      {failure ? (
        <div className="jf-honest-state">
          <Text as="p">{failure.message}</Text>
          {failure.type !== "insufficient" ? (
            <Form method="post"><input type="hidden" name="intent" value="onboarding.retry" /><Button submit>Try the read again</Button></Form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function InsightScene({
  insight,
  continueToAction,
  showAlternative,
  alternativeMessage,
  alternativeBusy,
}: {
  insight: InsightView | null;
  continueToAction: () => void;
  showAlternative: () => void;
  alternativeMessage: string | null;
  alternativeBusy: boolean;
}) {
  if (!insight) return <div className="jf-scene jf-insight-scene"><Kicker>Something jumped out</Kicker><div className="jf-honest-state"><Text as="p">I’m checking that the finding is strong enough to act on. Your answer is saved, and there’s nothing else you need to do.</Text></div></div>;
  return (
    <div className="jf-scene jf-insight-scene">
      <Kicker>Something jumped out</Kicker>
      <div className="jf-display jf-insight-title">{insight.headline}</div>
      <div className="jf-insight-copy"><Text as="p">{insight.explanation}</Text></div>
      <div className="jf-evidence">
        {insight.evidence.slice(0, 3).map((row) => <div className="jf-evidence-row" key={`${row.key}:${row.value}`}><span>{row.key}</span><Text as="p">{row.value}</Text></div>)}
      </div>
      {insight.caveat ? <Text as="p" tone="subdued">{insight.caveat}</Text> : null}
      <InlineStack gap="500" blockAlign="center" wrap>
        <Button variant="primary" onClick={continueToAction}>Here’s what I’d do →</Button>
        <Button variant="plain" onClick={showAlternative} disabled={alternativeBusy}>Show me something else</Button>
      </InlineStack>
      {alternativeMessage ? <div className="jf-secondary-note">{alternativeMessage}</div> : null}
    </div>
  );
}

function ActionScene({
  insight,
  recommendation,
  approvedMode,
  approve,
}: {
  insight: InsightView | null;
  recommendation: RecommendationView | null;
  approvedMode: string | null;
  approve: () => void;
}) {
  if (!recommendation) return <div className="jf-scene jf-action-scene"><div className="jf-honest-state">The recommendation is no longer available. I’ll keep learning and surface the next supported move in Jefe.</div></div>;
  return (
    <div className="jf-scene jf-action-scene">
      <div className="jf-recap"><span aria-hidden="true" />{insight?.headline ?? "The first supported opportunity"}</div>
      <div className="jf-display jf-action-title">Here’s what I’d do: <em>{recommendation.title}</em>.</div>
      <div className="jf-action-card">
        <ActionSection label="Why it matters" copy={recommendation.whyItMatters} />
        <ActionSection label="What I’ll do" copy={recommendation.whatIllDo} />
        <ActionSection label="How we’ll know" copy={recommendation.howWellKnow} />
        <div className="jf-action-divider" />
        {approvedMode ? (
          <div className="jf-approved"><span aria-hidden="true">✓</span>{approvedMode === "execute" ? "Approved. I’ll take it from here." : "Tracking. I’ll keep an eye on the success signal."}</div>
        ) : (
          <InlineStack gap="500" blockAlign="center" wrap>
            <Button variant="primary" onClick={approve}>{recommendation.approvalLabel}</Button>
            <Form method="post">
              <input type="hidden" name="intent" value="onboarding.recommendation.defer" />
              <input type="hidden" name="recommendationId" value={recommendation.id} />
              <Button variant="plain" submit>Not yet — keep it on my list</Button>
            </Form>
          </InlineStack>
        )}
      </div>
      <Text as="p" tone="subdued">I’ll track this and tell you when the success signal is ready to review.</Text>
    </div>
  );
}

function ActionSection({ label, copy }: { label: string; copy: string }) {
  return <div className="jf-action-section"><span>{label}</span><Text as="p">{copy}</Text></div>;
}

function AppScene({
  storeName,
  context,
  recommendation,
  queueItems,
}: {
  storeName: string;
  context: FastExperience["context"];
  recommendation: RecommendationView | null;
  queueItems: FastExperience["queueItems"];
}) {
  return (
    <div className="jf-scene jf-app-scene">
      <div className="jf-display jf-app-title">Here’s what I’m on, <em>{storeName}</em>.</div>
      {recommendation ? (
        <div className="jf-tracked-card">
          <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
            <span className="jf-card-kicker">Now tracking</span>
            <span className="jf-status-pill">{trackedStatus(recommendation)}</span>
          </InlineStack>
          <div className="jf-tracked-title">{recommendation.title}</div>
          {recommendation.successMeasure ? <Text as="p">Success signal: {recommendation.successMeasure}</Text> : null}
          {context?.echo ? <Text as="p" tone="subdued">Because you told me {context.echo}.</Text> : null}
        </div>
      ) : (
        <div className="jf-honest-state"><Text as="p">You’re in Jefe. I don’t have a recommendation strong enough to track yet, so I’ll keep learning and only surface one when the evidence supports it.</Text></div>
      )}
      {queueItems?.length ? (
        <div className="jf-queue">
          {queueItems.map((item) => <div className="jf-queue-row" key={item.id}><Text as="p">{item.title}</Text><span>{item.status}</span></div>)}
        </div>
      ) : (
        <div className="jf-empty-queue">No other evidence-backed opportunities are queued yet.</div>
      )}
    </div>
  );
}

function Kicker({ children, pulse = false }: { children: ReactNode; pulse?: boolean }) {
  return <div className={`jf-kicker ${pulse ? "is-pulse" : ""}`}><span aria-hidden="true" />{children}</div>;
}

function phaseIndex(phase: string) {
  if (["ready", "awaiting_context", "insufficient_evidence", "model_disabled"].includes(phase)) return 4;
  if (["checking_more_evidence", "evidence_ready", "choosing_first_move"].includes(phase)) return 3;
  if (phase === "checking_current_products") return 2;
  return 1;
}

function trackedStatus(recommendation: RecommendationView) {
  if (recommendation.executionStatus && ["applied", "partially_applied"].includes(recommendation.executionStatus)) return "Applied · monitoring";
  if (recommendation.executionStatus === "approved") return "Approved · preparing";
  if (recommendation.outcomeStatus === "measured") return "Reviewed";
  if (recommendation.status === "needs_review") return "Needs review";
  if (recommendation.status === "deferred") return "On your list";
  if (recommendation.reviewAt) {
    const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(recommendation.reviewAt));
    return `Tracking · review ${date}`;
  }
  return "Tracking";
}
