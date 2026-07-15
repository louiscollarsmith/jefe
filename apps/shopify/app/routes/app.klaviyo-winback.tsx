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
  Layout,
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
  connectKlaviyoPrivateKey,
  createWinbackProposal,
  disconnectKlaviyo,
  getWinbackDashboard,
} from "../services/klaviyo-winback.server";

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

  return (
    <Page>
      <Layout>
        <Layout.Section>
          <InlineStack align="center">
            <Box width="100%" maxWidth="980px">
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h1" variant="heading2xl">
                    Klaviyo Winback
                  </Text>
                  <Text as="p" variant="bodyLg" tone="subdued">
                    Draft a measured dormant-customer winback with approval,
                    House Rules and a randomised holdout.
                  </Text>
                </BlockStack>

                {actionData ? (
                  <Banner tone={actionData.ok ? "success" : "critical"}>
                    <Text as="p" variant="bodyMd">
                      {actionData.message}
                    </Text>
                  </Banner>
                ) : null}

                <ConnectionCard
                  connection={dashboard.connection}
                  isSubmitting={isSubmitting}
                />

                <ModeStatusCard dashboard={dashboard} />

                <ProposalCard proposal={proposal} isSubmitting={isSubmitting} />

                <RecentActions actions={dashboard.actions} />
              </BlockStack>
            </Box>
          </InlineStack>
        </Layout.Section>
      </Layout>
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

function ModeStatusCard({ dashboard }: { dashboard: LoaderData }) {
  const connected = dashboard.connection.status === "active";
  const draftPrepared = dashboard.actions.some((action) =>
    Boolean(action.executionStatus),
  );
  const klaviyoDraftCreated = dashboard.actions.some((action) =>
    Boolean(action.externalDraftId),
  );

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="100">
            <Text as="h2" variant="headingLg">
              Klaviyo mode
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Sending is disabled in this dev preview. No customer-facing
              emails will be sent.
            </Text>
          </BlockStack>
          <Badge tone="attention">Dry run / Draft only</Badge>
        </InlineStack>
        <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="300">
          <MetricBlock label="Klaviyo connected" value={connected ? "Yes" : "No"} />
          <MetricBlock
            label="Local draft prepared"
            value={draftPrepared ? "Yes" : "No"}
          />
          <MetricBlock
            label="Klaviyo draft created"
            value={klaviyoDraftCreated ? "Yes" : "No"}
          />
          <MetricBlock label="Send enabled" value="No" />
        </InlineGrid>
      </BlockStack>
    </Card>
  );
}

function ProposalCard({
  proposal,
  isSubmitting,
}: {
  proposal: LoaderData["proposal"];
  isSubmitting: boolean;
}) {
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

        <Form method="post">
          <input
            type="hidden"
            name="intent"
            value="create-winback-proposal"
          />
          <Button submit variant="primary" disabled={blocked} loading={isSubmitting}>
            Prepare approval draft
          </Button>
        </Form>
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
                      value={action.executionDryRun === false ? "Yes" : "No"}
                    />
                  </InlineGrid>
                  {action.status === "draft_prepared" ||
                  action.status === "needs_approval" ? (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value="approve-winback-proposal"
                      />
                      <input type="hidden" name="actionId" value={action.id} />
                      <Button submit variant="primary">
                        Approve in Jefe
                      </Button>
                    </Form>
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
    <BlockStack gap="100">
      <Text as="p" variant="bodySm" tone="subdued">
        {label}
      </Text>
      <Text as="p" variant="headingLg">
        {value}
      </Text>
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
  return "Needs approval";
}

function executionStatusLabel(status: string | null) {
  if (status === "draft_prepared") return "Prepared";
  return status ?? "Pending";
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
