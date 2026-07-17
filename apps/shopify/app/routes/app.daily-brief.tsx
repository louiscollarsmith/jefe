import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { generateDailyBrief } from "../services/daily-brief.server";
import {
  getOnboardingState,
  setOnboardingStepStatus,
} from "../services/onboarding.server";
import { getDailyBriefReadiness } from "../services/daily-brief-readiness.server";
import styles from "../styles/daily-brief.module.css";

type BriefConfidence = "low" | "medium" | "high";
type BriefStatus = "generated" | "degraded" | "failed";

type BriefSection = {
  type: "daily_verdict" | "inventory_guardian" | "watchdog" | "suggested_focus";
  title: string;
  summary: string;
  confidence?: BriefConfidence;
  valueAtRisk?: number;
  verificationClass?: "verified" | "estimated";
};

type DailyBriefView = {
  merchantName: string;
  shopDomain: string;
  generatedAt: string;
  periodStart: string;
  periodEnd: string;
  status: BriefStatus;
  confidenceLevel: BriefConfidence;
  dataIncomplete: boolean;
  degradedReasons: string[];
  failureReason: string | null;
  headline: string;
  verdict: {
    title: string;
    body: string;
  };
  sections: BriefSection[];
  todayNumbers: Array<{
    label: string;
    value: string;
  }>;
  whatChanged: string[];
  recommendedFocus: {
    type: string;
    title: string;
    reason: string;
    estimatedValue: string;
    valueLabel: string;
    confidence: BriefConfidence | "estimated" | "limited";
    riskLabel: string;
    effortLabel: string;
    href: string;
    buttonLabel: string;
    verificationClass: "verified" | "estimated";
    actionId?: string;
  };
  evidenceItems: string[];
  recommendationEvidence: {
    title: string;
    summary?: string;
    items: string[];
    secondaryItems: string[];
  };
  moduleSummaries: Array<{
    key: string;
    title: string;
    status: string;
    detail: string;
    href: string;
    confidence: BriefConfidence | "estimated";
  }>;
  optionalWarnings: string[];
  metrics: {
    revenue: {
      gross: number;
      net: number;
      refunded: number;
      currency: string;
    };
    inventory: {
      revenueAtRisk: number;
      grossProfitAtRisk: number | null;
      currency: string;
    } | null;
    watchdog: {
      estimatedValueAtRisk: number;
      currency: string;
    } | null;
  };
};

type DeliveryStatus = {
  inApp?: "ready" | "failed";
  email?: "not_configured" | "queued" | "sent" | "failed" | "logged";
  mode?: string;
  reason?: string;
  recipient?: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "daily_brief" },
  });
  const readiness = await getDailyBriefReadiness(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
    shopDomain: session.shop,
    sessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    source: "daily_brief_backfill_guard",
  });

  if (!readiness.briefReady) {
    throw redirect("/app/onboarding");
  }

  const latestBrief = readiness.latestBrief;
  const today = new Date().toISOString().slice(0, 10);
  const latestDate = latestBrief?.briefDate
    ? new Date(latestBrief.briefDate).toISOString().slice(0, 10)
    : null;
  let brief = latestBrief;

  if (!brief || latestDate !== today || !isDailyBriefV1Payload(brief.verdict)) {
    brief = await generateDailyBrief(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
  }

  if (!brief) {
    throw redirect("/app/onboarding");
  }

  const onboarding = await getOnboardingState(prisma, shop.id);
  if (!onboarding.requiredOnboardingComplete) {
    throw redirect("/app/onboarding");
  }

  if (brief) {
    await setOnboardingStepStatus(prisma, {
      shopId: shop.id,
      stepKey: "first_daily_brief",
      status: "complete",
      metadata: { viewedFrom: "daily_brief" },
    });
  }

  return { brief, onboarding };
};

export default function DailyBrief() {
  const { brief, onboarding } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const view = brief.verdict as unknown as DailyBriefView;
  const deliveryStatus = brief.deliveryStatus as DeliveryStatus;
  const todayNumbers = Array.isArray(view.todayNumbers)
    ? view.todayNumbers
    : [];
  const whatChanged = Array.isArray(view.whatChanged) ? view.whatChanged : [];
  const evidenceItems = Array.isArray(view.evidenceItems)
    ? view.evidenceItems
    : [];
  const moduleSummaries = Array.isArray(view.moduleSummaries)
    ? view.moduleSummaries
    : [];
  const optionalWarnings = Array.isArray(view.optionalWarnings)
    ? view.optionalWarnings
    : [];
  const onboardingWarnings = Array.isArray(onboarding.warnings)
    ? onboarding.warnings
    : [];
  const recommendedFocus = view.recommendedFocus ?? {
    title: "Review Daily Brief",
    reason: "Jefe regenerated this brief format. Review the latest evidence.",
    estimatedValue: "Unavailable",
    valueLabel: "Value at risk",
    confidence: "limited" as const,
    riskLabel: "Low",
    effortLabel: "~2 minutes",
    href: "/app/daily-brief",
    buttonLabel: "Review Daily Brief",
    verificationClass: "estimated" as const,
  };
  const verdict = view.verdict ?? {
    title: view.headline,
    body: "Review the latest Daily Brief evidence before taking action.",
  };
  const recommendationEvidence = view.recommendationEvidence ?? {
    title: "Why Jefe recommends this",
    summary: "Review the latest evidence before taking action.",
    items: evidenceItems,
    secondaryItems: [],
  };

  return (
    <Page fullWidth>
      <div className={styles.briefing}>
        <header className={styles.header}>
          <Text as="h1" variant="heading2xl">
            Daily Brief
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            {formatPeriod(view.periodStart, view.periodEnd)} · Generated{" "}
            {formatDateTime(view.generatedAt)} · Email{" "}
            {formatEmailStatus(deliveryStatus)}
          </Text>
          <div className={styles.statusRow}>
            <Badge tone={statusTone(view.status)}>
              {formatStatus(view.status)}
            </Badge>
            <Badge tone={confidenceTone(view.confidenceLevel)}>
              {`${formatConfidence(view.confidenceLevel)} confidence`}
            </Badge>
          </div>
        </header>

        {view.status === "failed" ? (
          <Box paddingBlockStart="500">
            <Banner tone="critical">
              <BlockStack gap="150">
                <Text as="p" variant="bodyMd">
                  Data is incomplete. Here is what Jefe can verify.
                </Text>
                {view.degradedReasons.map((reason) => (
                  <Text as="p" variant="bodySm" key={reason}>
                    {reason}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          </Box>
        ) : null}

        <section className={styles.verdict}>
          <h2 className={styles.verdictTitle}>{verdict.title}</h2>
          <p className={styles.verdictBody}>{verdict.body}</p>
        </section>

        <section className={styles.actionCard}>
          <p className={styles.eyebrow}>Recommended action</p>
          <h2 className={styles.actionTitle}>{recommendedFocus.title}</h2>
          <p className={styles.actionReason}>{recommendedFocus.reason}</p>
          <div className={styles.actionButtonRow}>
            <Button
              variant="primary"
              onClick={() => navigate(recommendedFocus.href)}
            >
              {recommendedFocus.buttonLabel}
            </Button>
            <Text as="p" variant="bodySm" tone="subdued">
              No action runs automatically.
            </Text>
          </div>
          <div className={styles.actionMeta}>
            <ActionMeta
              label={recommendedFocus.valueLabel}
              value={recommendedFocus.estimatedValue}
            />
            <ActionMeta label="Risk" value={recommendedFocus.riskLabel} />
            <ActionMeta label="Effort" value={recommendedFocus.effortLabel} />
          </div>
        </section>

        <section className={styles.keyNumbers}>
          <h3 className={styles.sectionTitle}>Key numbers</h3>
          <div className={styles.keyNumberGrid}>
            {todayNumbers.map((number) => (
              <KeyNumber
                key={number.label}
                label={number.label}
                value={number.value}
              />
            ))}
          </div>
        </section>

        <section className={styles.explanation}>
          <h3 className={styles.sectionTitle}>Why Jefe recommends this</h3>
          <p className={styles.explanationText}>
            {recommendationEvidence.summary ?? recommendationEvidence.title}
          </p>
          <div className={styles.evidenceList}>
            {recommendationEvidence.items.map((item) => (
              <EvidenceItem key={item}>{item}</EvidenceItem>
            ))}
            {whatChanged.map((item) => (
              <EvidenceItem key={item}>{item}</EvidenceItem>
            ))}
            {recommendationEvidence.secondaryItems.map((item) => (
              <EvidenceItem key={item}>{item}</EvidenceItem>
            ))}
          </div>
        </section>

        {[
          ...optionalWarnings,
          ...onboardingWarnings.map((warning) =>
            normalizeBriefWarning(warning.message),
          ),
        ]
          .filter((warning, index, all) => all.indexOf(warning) === index)
          .map((warning) => (
            <p className={styles.inlineNote} key={warning}>
              {warning}
            </p>
          ))}

        <section className={styles.moduleList} aria-label="Supporting modules">
          {moduleSummaries.map((summary) => (
            <ModuleSummary
              key={summary.key}
              summary={summary}
              onOpen={() => navigate(summary.href)}
            />
          ))}
        </section>
      </div>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function isDailyBriefV1Payload(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<DailyBriefView>;

  return (
    Array.isArray(payload.todayNumbers) &&
    Array.isArray(payload.whatChanged) &&
    Boolean(payload.verdict) &&
    Boolean(payload.recommendedFocus) &&
    Boolean(payload.recommendationEvidence) &&
    typeof payload.recommendationEvidence?.summary === "string" &&
    Array.isArray(payload.evidenceItems) &&
    Array.isArray(payload.moduleSummaries) &&
    Array.isArray(payload.optionalWarnings)
  );
}

function normalizeBriefWarning(message: string) {
  if (/margin insights|margin confidence|product costs/i.test(message)) {
    return "Until product costs are added, gross profit and margin-based recommendations will stay limited.";
  }

  return message;
}

function ModuleSummary({
  summary,
  onOpen,
}: {
  summary: DailyBriefView["moduleSummaries"][number];
  onOpen: () => void;
}) {
  return (
    <div className={styles.moduleRow}>
      <div className={styles.moduleTitle}>{summary.title}</div>
      <div className={styles.moduleStatus}>{summary.status}</div>
      <div className={styles.moduleDetail}>{summary.detail}</div>
      <div className={styles.moduleButton}>
        <Button size="slim" onClick={onOpen}>
          Open
        </Button>
      </div>
    </div>
  );
}

function ActionMeta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={styles.metaLabel}>{label}</p>
      <p className={styles.metaValue}>{value}</p>
    </div>
  );
}

function KeyNumber({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={styles.keyNumberLabel}>{label}</p>
      <p className={styles.keyNumberValue}>{value}</p>
    </div>
  );
}

function EvidenceItem({ children }: { children: string }) {
  return (
    <div className={styles.evidenceItem}>
      <span className={styles.checkmark}>✓</span>
      <span>{children}</span>
    </div>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatPeriod(start: string, end: string) {
  const displayEnd = new Date(new Date(end).getTime() - 1);
  return `${formatDayMonth(start)}-${formatDayMonth(displayEnd.toISOString())}`;
}

function formatDayMonth(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function formatConfidence(
  confidence: BriefConfidence | "estimated" | "limited",
) {
  return confidence[0].toUpperCase() + confidence.slice(1);
}

function formatStatus(status: string) {
  const display = status.replace(/_/g, " ");
  return display[0].toUpperCase() + display.slice(1);
}

function formatEmailStatus(status: DeliveryStatus) {
  if (status.email === "logged") return "preview logged";
  if (status.email === "not_configured") return "not configured";
  return status.email ?? "not configured";
}

function statusTone(status: BriefStatus) {
  if (status === "generated") return "success";
  if (status === "degraded") return "warning";
  return "critical";
}

function confidenceTone(confidence: BriefConfidence | "estimated" | "limited") {
  if (confidence === "high") return "success";
  if (confidence === "estimated") return "info";
  if (confidence === "limited") return "warning";
  if (confidence === "medium") return "attention";
  return "warning";
}
