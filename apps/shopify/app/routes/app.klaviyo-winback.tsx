import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  DataTable,
  FormLayout,
  InlineGrid,
  InlineStack,
  List,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";

import prisma from "../db.server";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { authenticate } from "../shopify.server";
import {
  approveWinbackProposal,
  cancelWinbackProposal,
  connectKlaviyoPrivateKey,
  createWinbackProposal,
  disconnectKlaviyo,
  getWinbackDashboard,
  rejectWinbackProposal,
} from "../services/klaviyo-winback.server";
import styles from "../styles/manager-briefing.module.css";

type LoaderData = Awaited<ReturnType<typeof getWinbackDashboard>>;

type ActionData = {
  ok: boolean;
  message: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "klaviyo_winback" },
  });

  return getWinbackDashboard(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
  });
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData> => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "klaviyo_winback" },
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  try {
    if (intent === "connect-klaviyo") {
      await connectKlaviyoPrivateKey(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        privateKey: String(formData.get("privateKey") ?? ""),
      });

      return {
        ok: true,
        message:
          "Klaviyo key reference saved. The raw private key was not stored in the app database.",
      };
    }

    if (intent === "disconnect-klaviyo") {
      await disconnectKlaviyo(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
      });

      return { ok: true, message: "Klaviyo connection removed." };
    }

    if (intent === "create-winback-proposal") {
      const action = await createWinbackProposal(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
      });

      return {
        ok: action.status !== "blocked",
        message:
          action.status === "blocked"
            ? "Winback proposal is blocked by House Rules or missing audience data."
            : "Winback proposal prepared for approval. No customer email was sent.",
      };
    }

    if (intent === "approve-winback-proposal") {
      await approveWinbackProposal(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId: String(formData.get("actionId") ?? ""),
      });

      return {
        ok: true,
        message:
          "Winback proposal approved in Jefe. Klaviyo sending is still manual in v0.",
      };
    }

    if (intent === "reject-winback-proposal") {
      await rejectWinbackProposal(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId: String(formData.get("actionId") ?? ""),
        reason: String(formData.get("reason") ?? "") || null,
      });

      return {
        ok: true,
        message: "Winback proposal rejected. No customer email was sent.",
      };
    }

    if (intent === "cancel-winback-proposal") {
      await cancelWinbackProposal(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        actionId: String(formData.get("actionId") ?? ""),
        reason: "Cancelled from Klaviyo Winback queue.",
      });

      return {
        ok: true,
        message: "Winback proposal cancelled. No customer email was sent.",
      };
    }
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? error.message
          : "Klaviyo winback action could not be completed.",
    };
  }

  return { ok: false, message: "Unknown winback action." };
};

export default function KlaviyoWinback() {
  const dashboard = useLoaderData<LoaderData>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";
  const proposal = dashboard.proposal;
  const connected = dashboard.connection.status === "active";
  const draftPrepared = dashboard.actions.some(
    (action) =>
      action.executionStatus === "draft_prepared" ||
      Boolean(action.externalDraftId),
  );

  return (
    <Page fullWidth>
      <div className={styles.briefing}>
        <header className={styles.header}>
          <Text as="h1" variant="heading2xl">
            Klaviyo Winback
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Draft only · Send disabled
          </Text>
          <div className={styles.statusRow}>
            <Badge tone="attention">Draft only</Badge>
            <Badge tone="info">Estimated</Badge>
            <Badge tone={connected ? "success" : "attention"}>
              {connected ? "Klaviyo connected" : "Klaviyo not connected"}
            </Badge>
          </div>
        </header>

        {actionData ? (
          <Box paddingBlockStart="500">
            <Banner tone={actionData.ok ? "success" : "critical"}>
              <Text as="p" variant="bodyMd">
                {actionData.message}
              </Text>
            </Banner>
          </Box>
        ) : null}

        <section className={styles.verdict}>
          <h2 className={styles.verdictTitle}>
            {proposal.audience.eligibleCount > 0
              ? `Jefe found ${proposal.audience.eligibleCount} dormant customer${proposal.audience.eligibleCount === 1 ? "" : "s"} worth preparing a winback draft for.`
              : "No dormant customer draft is ready yet."}
          </h2>
          <p className={styles.verdictBody}>
            This is a measured campaign proposal with a treatment group and
            holdout. No customer-facing email will be sent from Jefe.
          </p>
        </section>

        <PrimaryWinbackAction
          connected={connected}
          blocked={proposal.status === "blocked"}
          draftPrepared={draftPrepared}
          isSubmitting={isSubmitting}
        />

        <section className={styles.keyNumbers}>
          <h3 className={styles.sectionTitle}>Key numbers</h3>
          <div className={styles.keyNumberGrid}>
            <MetricBlock
              label="Eligible customers"
              value={String(proposal.audience.eligibleCount)}
            />
            <MetricBlock
              label="Treatment"
              value={String(proposal.audience.treatmentCount)}
            />
            <MetricBlock
              label="Holdout"
              value={String(proposal.audience.holdoutCount)}
            />
            <MetricBlock
              label="Estimated upside"
              value={formatMoney(
                proposal.economics.expectedRevenueAfterDiscount.base,
                proposal.economics.currency,
              )}
            />
          </div>
        </section>

        <SafetyChecks dashboard={dashboard} />

        <section id="klaviyo-connection">
          <ConnectionCard
            connection={dashboard.connection}
            isSubmitting={isSubmitting}
          />
        </section>

        <ProposalCard proposal={proposal} />

        <RecentActions actions={dashboard.actions} />
      </div>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function ConnectionCard({
  connection,
  isSubmitting,
}: {
  connection: LoaderData["connection"];
  isSubmitting: boolean;
}) {
  const connected = connection.status === "active";
  const [privateKey, setPrivateKey] = useState("");

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="100">
            <Text as="h2" variant="headingLg">
              Klaviyo connection
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Pilot mode uses a merchant-generated private key. The raw key is
              not shown after save.
            </Text>
          </BlockStack>
          <Badge tone={connected ? "success" : "attention"}>
            {connected ? "Connected" : "Not connected"}
          </Badge>
        </InlineStack>

        {connected ? (
          <InlineStack align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="100">
              <Text as="p" variant="bodyMd">
                Key: {connection.maskedKey ?? "masked"}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Last checked:{" "}
                {connection.lastCheckedAt
                  ? formatDateTime(connection.lastCheckedAt)
                  : "Not checked yet"}
              </Text>
            </BlockStack>
            <Form method="post">
              <input type="hidden" name="intent" value="disconnect-klaviyo" />
              <Button submit tone="critical" loading={isSubmitting}>
                Remove
              </Button>
            </Form>
          </InlineStack>
        ) : (
          <Form method="post">
            <input type="hidden" name="intent" value="connect-klaviyo" />
            <FormLayout>
              <TextField
                label="Klaviyo private API key"
                name="privateKey"
                value={privateKey}
                onChange={setPrivateKey}
                type="password"
                autoComplete="off"
                helpText="Saved as a masked key reference for v0; no production secret is committed or logged."
              />
              <Button submit variant="primary" loading={isSubmitting}>
                Save key reference
              </Button>
            </FormLayout>
          </Form>
        )}
      </BlockStack>
    </Card>
  );
}

function PrimaryWinbackAction({
  connected,
  blocked,
  draftPrepared,
  isSubmitting,
}: {
  connected: boolean;
  blocked: boolean;
  draftPrepared: boolean;
  isSubmitting: boolean;
}) {
  if (!connected) {
    return (
      <section className={styles.actionCard}>
        <p className={styles.eyebrow}>Primary action</p>
        <h3 className={styles.actionTitle}>Connect Klaviyo</h3>
        <p className={styles.actionReason}>
          Jefe needs a Klaviyo connection before it can prepare a safe measured
          winback draft.
        </p>
        <div className={styles.actionButtonRow}>
          <Button variant="primary" url="#klaviyo-connection">
            Connect Klaviyo
          </Button>
        </div>
        <div className={styles.actionMeta}>
          <MetricBlock label="Mode" value="Draft only" />
          <MetricBlock label="Send enabled" value="No" />
          <MetricBlock label="Risk" value="Low" />
        </div>
      </section>
    );
  }

  if (draftPrepared) {
    return (
      <section className={styles.actionCard}>
        <p className={styles.eyebrow}>Primary action</p>
        <h3 className={styles.actionTitle}>Draft prepared in Klaviyo</h3>
        <p className={styles.actionReason}>
          Review the prepared draft and approval history. Jefe still will not
          send customer-facing email automatically.
        </p>
        <div className={styles.actionMeta}>
          <MetricBlock label="Mode" value="Draft only" />
          <MetricBlock label="Send enabled" value="No" />
          <MetricBlock label="Status" value="Prepared" />
        </div>
      </section>
    );
  }

  return (
    <section className={styles.actionCard}>
      <p className={styles.eyebrow}>Primary action</p>
      <h3 className={styles.actionTitle}>Prepare Klaviyo draft</h3>
      <p className={styles.actionReason}>
        Create a draft campaign and treatment list in Klaviyo. Holdout customers
        are excluded so Jefe can measure incremental lift.
      </p>
      <div className={styles.actionButtonRow}>
        <Form method="post">
          <input
            type="hidden"
            name="intent"
            value="create-winback-proposal"
          />
          <Button
            submit
            variant="primary"
            disabled={blocked}
            loading={isSubmitting}
          >
            Create Klaviyo draft
          </Button>
        </Form>
      </div>
      <div className={styles.actionMeta}>
        <MetricBlock label="Mode" value="Draft only" />
        <MetricBlock label="Holdout" value="Excluded" />
        <MetricBlock label="Send enabled" value="No" />
      </div>
    </section>
  );
}

function SafetyChecks({ dashboard }: { dashboard: LoaderData }) {
  const connected = dashboard.connection.status === "active";
  const proposal = dashboard.proposal;
  const blocked = proposal.status === "blocked";

  return (
    <section className={styles.explanation}>
      <h3 className={styles.sectionTitle}>Safety checks</h3>
      <p className={styles.explanationText}>
        Holdout customers are excluded so Jefe can measure whether the campaign
        creates incremental lift. Estimated value will only become verified
        after measurement.
      </p>
      <div className={styles.evidenceList}>
        <EvidenceItem>Holdout assigned</EvidenceItem>
        <EvidenceItem>
          {blocked ? "House Rules blocked this draft" : "House Rules passed"}
        </EvidenceItem>
        <EvidenceItem>Send disabled</EvidenceItem>
        <EvidenceItem>
          {connected ? "Klaviyo connected" : "Klaviyo connection required"}
        </EvidenceItem>
      </div>
    </section>
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

function ProposalCard({ proposal }: { proposal: LoaderData["proposal"] }) {
  const blocked = proposal.status === "blocked";

  return (
    <Card>
      <BlockStack gap="500">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="100">
            <Text as="h2" variant="headingLg">
              Dormant audience opportunity
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Customers who bought 60-180 days ago and have not reordered in
              the last 60 days.
            </Text>
          </BlockStack>
          <Badge tone={blocked ? "critical" : "info"}>
            {blocked ? "Blocked" : "Estimated"}
          </Badge>
        </InlineStack>

        {blocked ? (
          <Banner tone="critical">
            <List>
              {proposal.blockedReasons.map((reason) => (
                <List.Item key={reason}>{reason}</List.Item>
              ))}
            </List>
          </Banner>
        ) : null}

        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
          <MetricBlock
            label="Eligible"
            value={String(proposal.audience.eligibleCount)}
          />
          <MetricBlock
            label="Treatment"
            value={String(proposal.audience.treatmentCount)}
          />
          <MetricBlock
            label="Holdout"
            value={String(proposal.audience.holdoutCount)}
          />
          <MetricBlock
            label="Estimated base upside"
            value={formatMoney(
              proposal.economics.expectedRevenueAfterDiscount.base,
              proposal.economics.currency,
            )}
          />
        </InlineGrid>
        <Text as="p" variant="bodySm" tone="subdued">
          Estimated base upside is based on the base conversion assumption. Not
          verified.
        </Text>

        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                Estimated upside vs discount cost
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Based on 2%-8% estimated conversion. Discount cost is the
                expected cost of the {proposal.economics.discountPercent}%
                offer, not a verified campaign result.
              </Text>
            </BlockStack>
            <DataTable
              columnContentTypes={["text", "numeric", "numeric", "numeric"]}
              headings={[
                "Scenario",
                "Expected revenue",
                "Discount cost",
                "Net after discount",
              ]}
              rows={["low", "base", "high"].map((scenario) => {
                const key = scenario as "low" | "base" | "high";

                return [
                  scenarioLabel(key),
                  formatMoney(
                    proposal.economics.expectedRevenue[key],
                    proposal.economics.currency,
                  ),
                  formatMoney(
                    proposal.economics.estimatedDiscountCost[key],
                    proposal.economics.currency,
                  ),
                  formatMoney(
                    proposal.economics.expectedRevenueAfterDiscount[key],
                    proposal.economics.currency,
                  ),
                ];
              })}
            />
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                Preview
              </Text>
              <List>
                <List.Item>
                  Campaign: {proposal.preview.campaignName}
                </List.Item>
                <List.Item>Discount: {proposal.preview.discount}</List.Item>
                <List.Item>
                  Subject: {proposal.preview.subjectLine}
                </List.Item>
                <List.Item>
                  Holdout: {proposal.audience.holdoutCount} customers randomly
                  excluded from the send to measure lift
                </List.Item>
                <List.Item>No automatic send</List.Item>
              </List>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">
                House Rules and caps
              </Text>
              <List>
                {proposal.capsApplied.map((cap) => (
                  <List.Item key={cap.rule}>{capLabel(cap)}</List.Item>
                ))}
              </List>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card>
          <BlockStack gap="300">
            <BlockStack gap="100">
              <Text as="h3" variant="headingMd">
                Email campaign copy preview
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                Deterministic preview only. No AI copy generation and no send in
                this dev flow.
              </Text>
            </BlockStack>
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                <strong>Subject:</strong> {proposal.preview.subjectLine}
              </Text>
              <Text as="p" variant="bodyMd">
                <strong>Preview text:</strong> {proposal.preview.previewText}
              </Text>
              <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                <BlockStack gap="300">
                  <Text as="h4" variant="headingMd">
                    {proposal.preview.headline}
                  </Text>
                  {proposal.preview.bodyCopy.map((paragraph) => (
                    <Text as="p" variant="bodyMd" key={paragraph}>
                      {paragraph}
                    </Text>
                  ))}
                  <Text as="p" variant="bodyMd">
                    <strong>{proposal.preview.ctaText}</strong>
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {proposal.preview.footerNote}
                  </Text>
                </BlockStack>
              </Box>
            </BlockStack>
          </BlockStack>
        </Card>

        {proposal.audience.sample.length > 0 ? (
          <DataTable
            columnContentTypes={["text", "text", "numeric", "numeric", "numeric"]}
            headings={["Customer", "Group", "Days dormant", "Orders", "AOV"]}
            rows={proposal.audience.sample.map((customer) => [
              customer.maskedEmail,
              customer.group,
              customer.daysSinceLastOrder,
              customer.previousOrderCount,
              formatMoney(
                customer.averageOrderValue,
                proposal.economics.currency,
              ),
            ])}
          />
        ) : null}

        <Banner tone="info">
          <Text as="p" variant="bodyMd">
            Holdout customers are not blocked by House Rules. They are randomly
            excluded from the send so verified lift can be measured separately
            from this proposal.
          </Text>
        </Banner>

      </BlockStack>
    </Card>
  );
}

function RecentActions({ actions }: { actions: LoaderData["actions"] }) {
  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h2" variant="headingLg">
          Approval queue
        </Text>
        {actions.length === 0 ? (
          <Text as="p" variant="bodyMd" tone="subdued">
            No winback proposals have been prepared yet.
          </Text>
        ) : (
          <BlockStack gap="300">
            {actions.map((action) => (
              <Card key={action.id}>
                <BlockStack gap="300">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Badge tone={statusTone(action.status)}>
                        {statusLabel(action.status)}
                      </Badge>
                      <Badge tone="info">{`${action.riskLevel} risk`}</Badge>
                      <Badge tone="attention">Estimated</Badge>
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {formatDateTime(action.proposedAt)}
                    </Text>
                  </InlineStack>
                  <InlineGrid columns={{ xs: 1, sm: 4 }} gap="300">
                    <MetricBlock
                      label="Action type"
                      value={action.externalSystem}
                    />
                    <MetricBlock
                      label="Expected value"
                      value={formatActionValue(action)}
                    />
                    <MetricBlock
                      label="Verification"
                      value={verificationLabel(action)}
                    />
                    <MetricBlock
                      label="Execution mode"
                      value={executionModeLabel(action.executionMode)}
                    />
                  </InlineGrid>
                  <InlineGrid columns={{ xs: 1, sm: 4 }} gap="300">
                    <MetricBlock
                      label="Treatment"
                      value={String(action.treatmentCount)}
                    />
                    <MetricBlock
                      label="Holdout"
                      value={String(action.holdoutCount)}
                    />
                    <MetricBlock
                      label="Draft"
                      value={executionStatusLabel(action.executionStatus)}
                    />
                    <MetricBlock
                      label="Send enabled"
                      value="No"
                    />
                  </InlineGrid>

                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        House Rules consulted
                      </Text>
                      <List>
                        {action.rulesConsulted.map(
                          (rule: Record<string, unknown>, index: number) => (
                          <List.Item key={`${action.id}-rule-${index}`}>
                            {ruleLabel(rule)}
                          </List.Item>
                          ),
                        )}
                      </List>
                    </BlockStack>
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Caps applied
                      </Text>
                      <List>
                        {action.capsApplied.map(
                          (cap: Record<string, unknown>) => (
                          <List.Item key={`${action.id}-${cap.rule}`}>
                            {capLabel(cap)}
                          </List.Item>
                          ),
                        )}
                      </List>
                    </BlockStack>
                  </InlineGrid>

                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                    <HistoryList
                      title="Approval history"
                      emptyText="No approval decision recorded yet."
                      items={action.approvalHistory.map((event: {
                        id: string;
                        previousStatus: string;
                        newStatus: string;
                        actorType: string;
                        reason: string | null;
                        eventTs: string;
                      }) => ({
                        id: event.id,
                        label: `${statusLabel(event.previousStatus)} -> ${statusLabel(
                          event.newStatus,
                        )}`,
                        detail: [
                          formatDateTime(event.eventTs),
                          event.actorType,
                          event.reason,
                        ].filter(Boolean).join(" · "),
                      }))}
                    />
                    <HistoryList
                      title="Execution history"
                      emptyText="No execution attempt recorded yet."
                      items={action.executionHistory.map((event: {
                        id: string;
                        status: string;
                        dryRun: boolean;
                        connector: string;
                        createdAt: string;
                        completedAt: string | null;
                      }) => ({
                        id: event.id,
                        label: executionStatusLabel(event.status),
                        detail: [
                          event.connector,
                          event.dryRun ? "Dry run" : "Live",
                          event.completedAt
                            ? formatDateTime(event.completedAt)
                            : formatDateTime(event.createdAt),
                        ].join(" · "),
                      }))}
                    />
                  </InlineGrid>

                  <InlineStack gap="200">
                    {action.status === "needs_approval" ? (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="approve-winback-proposal"
                        />
                        <input type="hidden" name="actionId" value={action.id} />
                        <Button submit variant="primary">
                          Approve
                        </Button>
                      </Form>
                    ) : null}
                    {action.status === "needs_approval" ||
                    action.status === "approved" ? (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="reject-winback-proposal"
                        />
                        <input type="hidden" name="actionId" value={action.id} />
                        <input
                          type="hidden"
                          name="reason"
                          value="Rejected from Klaviyo Winback queue."
                        />
                        <Button submit>
                          Reject
                        </Button>
                      </Form>
                    ) : null}
                    {["proposed", "draft_prepared", "needs_approval", "approved"].includes(
                      action.status,
                    ) ? (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="cancel-winback-proposal"
                        />
                        <input type="hidden" name="actionId" value={action.id} />
                        <Button submit>
                          Cancel
                        </Button>
                      </Form>
                    ) : null}
                    <Button disabled>Execute</Button>
                  </InlineStack>

                  {action.externalDraftId || action.externalExecutionId ? (
                    <Text as="p" variant="bodySm" tone="subdued">
                      External draft: {action.externalDraftId ?? "none"} ·
                      External execution: {action.externalExecutionId ?? "none"}
                    </Text>
                  ) : null}
                </BlockStack>
              </Card>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

function MetricBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={styles.keyNumberLabel}>{label}</p>
      <p className={styles.keyNumberValue}>{value}</p>
    </div>
  );
}

function HistoryList({
  title,
  emptyText,
  items,
}: {
  title: string;
  emptyText: string;
  items: Array<{ id: string; label: string; detail: string }>;
}) {
  return (
    <BlockStack gap="200">
      <Text as="h3" variant="headingSm">
        {title}
      </Text>
      {items.length === 0 ? (
        <Text as="p" variant="bodySm" tone="subdued">
          {emptyText}
        </Text>
      ) : (
        <List>
          {items.map((item) => (
            <List.Item key={item.id}>
              {item.label}: {item.detail}
            </List.Item>
          ))}
        </List>
      )}
    </BlockStack>
  );
}

function capLabel(cap: Record<string, unknown>) {
  if (cap.rule === "winback_discount_cap") {
    return `Max winback discount: ${String(
      cap.display ?? "winback discount cap applied",
    )}.`;
  }
  if (cap.rule === "campaign_audience_cap") {
    const overflowCount = Number(cap.overflowCount ?? 0);
    if (overflowCount === 0) {
      return `Audience cap: ${cap.includedCount} of ${cap.eligibleCount} eligible customers are within the cap.`;
    }

    return `Audience cap: ${cap.includedCount} of ${cap.eligibleCount} eligible customers included; ${overflowCount} over cap.`;
  }
  if (cap.rule === "email_cooldown") {
    return `Email cooldown: ${cap.appliedValue} day cooldown checked where history exists.`;
  }
  if (cap.rule === "no_automatic_send") {
    return "No customer-facing send without approval.";
  }
  if (cap.rule === "bfcm_freeze_mode") {
    return cap.appliedValue
      ? "Freeze mode: blocks this draft."
      : "Freeze mode: off.";
  }
  return String(cap.rule);
}

function statusTone(status: string) {
  if (status === "approved") return "success";
  if (status === "blocked") return "critical";
  if (status === "rejected" || status === "cancelled") return "critical";
  if (status === "draft_prepared" || status === "needs_approval") {
    return "attention";
  }
  return "attention";
}

function statusLabel(status: string) {
  if (status === "approved") return "Approved";
  if (status === "blocked") return "Blocked";
  if (status === "draft_prepared") return "Draft prepared";
  if (status === "needs_approval") return "Needs approval";
  if (status === "rejected") return "Rejected";
  if (status === "cancelled") return "Cancelled";
  if (status === "executed") return "Executed";
  if (status === "verified") return "Verified";
  return status;
}

function executionStatusLabel(status: string | null) {
  if (status === "draft_prepared") return "Prepared";
  if (status === "dry_run_executed") return "Dry run executed";
  return status ?? "Pending";
}

function executionModeLabel(mode: string) {
  if (mode === "draft_only") return "Draft only";
  if (mode === "dry_run") return "Dry run";
  if (mode === "live_write_disabled") return "Live disabled";
  if (mode === "live") return "Live";
  return mode;
}

function verificationLabel(action: LoaderData["actions"][number]) {
  const classLabel =
    action.verificationClass === "verified" ? "Verified" : "Estimated";
  const valueLabel = action.valueType.replace(/_/g, " ");

  return `${classLabel} · ${valueLabel}`;
}

function formatActionValue(action: LoaderData["actions"][number]) {
  const expectedValue = action.expectedValue as {
    expectedRevenueAfterDiscount?: { base?: number };
    expectedRevenue?: { base?: number };
    currency?: string;
  };
  const value =
    expectedValue.expectedRevenueAfterDiscount?.base ??
    expectedValue.expectedRevenue?.base ??
    0;

  return formatMoney(value, action.valueCurrency ?? expectedValue.currency ?? "GBP");
}

function ruleLabel(rule: Record<string, unknown>) {
  const source = String(rule.source ?? "house rules");
  const rules = Array.isArray(rule.rules) ? rule.rules.join(", ") : "policy";

  return `${source}: ${rules}`;
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(value);
}

function scenarioLabel(scenario: "low" | "base" | "high") {
  if (scenario === "low") return "Low";
  if (scenario === "high") return "High";
  return "Base";
}
