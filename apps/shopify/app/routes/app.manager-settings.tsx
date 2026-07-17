import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Fragment, type FormEvent, useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useRouteError,
  useSubmit,
} from "react-router";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  DataTable,
  FormLayout,
  Icon,
  InlineStack,
  Link,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { ExternalSmallIcon } from "@shopify/polaris-icons";
import { boundary } from "@shopify/shopify-app-react-router/server";

import prisma from "../db.server";
import {
  calculateCogsCompletion,
  ensureOnboardingTenant,
  getOnboardingState,
  saveOnboardingApprovalMode,
  saveOnboardingCogsInputs,
  saveOnboardingGoals,
  saveOnboardingHouseRules,
} from "../services/onboarding.server";
import { HOUSE_RULE_DEFAULTS } from "../services/house-rules-policy";
import { authenticate } from "../shopify.server";
import styles from "../styles/manager-briefing.module.css";

const settingsTasks = [
  "goal",
  "house-rules",
  "approval-mode",
  "product-costs",
  "brand-voice",
  "protected-products",
] as const;

type SettingsTask = (typeof settingsTasks)[number];

const houseRulesFields = [
  "maxDefaultDiscountPercent",
  "maxWinbackDiscountPercent",
  "allowWinbackDiscountAboveDefault",
  "minimumMarginPercent",
  "priorityMode",
  "maxEmailsPerCustomer",
  "emailFrequencyScope",
  "maxCampaignAudienceSize",
  "emailCooldownDays",
  "bfcmFreezeMode",
  "actionsRequiringExtraApproval",
  "riskyPeriods",
  "freeTextRules",
];

const brandVoiceFields = ["brandVoice"];
const protectedProductFields = ["neverDiscountedSkus", "protectedProducts"];

const priorityModeOptions = [
  { label: "Choose mode", value: "" },
  { label: "Protect margin", value: "protect_margin" },
  { label: "Balanced", value: "balanced" },
  { label: "Push growth", value: "growth" },
];

const emailFrequencyScopeOptions = [
  { label: "Choose scope", value: "" },
  { label: "Per customer per week", value: "per_customer_per_week" },
  { label: "Per customer per month", value: "per_customer_per_month" },
  { label: "Per segment per week", value: "per_segment_per_week" },
  { label: "Per campaign type", value: "per_campaign_type" },
];

const approvalModeOptions = [
  { label: "Choose approval mode", value: "" },
  { label: "Very cautious", value: "very_cautious" },
  { label: "Balanced", value: "balanced" },
  { label: "Experimental", value: "experimental" },
];

const goalExampleOptions = {
  THREE_MONTHS: [
    { label: "Choose a starting point", value: "" },
    {
      label: "Protect margin",
      value:
        "Get contribution margin under control by finding where discounts, refunds, COGS gaps, and stockouts are costing us money.",
    },
    {
      label: "Stop operational leaks",
      value:
        "Catch stockouts, conversion drops, refund spikes, and broken campaigns before they turn into missed revenue.",
    },
    {
      label: "Win back dormant customers",
      value:
        "Prepare a safe winback campaign with a holdout group so we can prove whether retention work is profitable.",
    },
  ],
  SIX_MONTHS: [
    { label: "Choose a starting point", value: "" },
    {
      label: "Build a daily operating rhythm",
      value:
        "Run the store from a daily brief that shows the highest-value issue, the evidence, and the action needed.",
    },
    {
      label: "Improve repeat purchase",
      value:
        "Increase repeat purchase revenue without over-emailing or training customers to wait for discounts.",
    },
    {
      label: "Make stock planning predictable",
      value:
        "Reduce avoidable stockouts and over-ordering by using sales velocity, margin, and revenue-at-risk signals.",
    },
  ],
  TWELVE_MONTHS: [
    { label: "Choose a starting point", value: "" },
    {
      label: "Create accountable growth",
      value:
        "Grow profitably with clear separation between verified incremental lift and estimated prevention.",
    },
    {
      label: "Reduce founder firefighting",
      value:
        "Move from reactive store checks to a managed operating system where issues are surfaced with evidence and bounded next actions.",
    },
    {
      label: "Build a margin-first engine",
      value:
        "Make margin, stock health, retention, and House Rules the default operating constraints for every recommendation.",
    },
  ],
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const task = normalizeSettingsTask(url.searchParams.get("task"));
  const { merchant, shop } = await ensureOnboardingTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
  });
  const shouldLoadProducts = task === "product-costs";
  const [goals, houseRule, products, cogsStats, onboarding] = await Promise.all([
    prisma.goal.findMany({
      where: { merchantId: merchant.id, shopId: shop.id, status: "active" },
      orderBy: { horizon: "asc" },
    }),
    prisma.houseRule.findFirst({
      where: {
        merchantId: merchant.id,
        shopId: shop.id,
        status: "active",
        title: "Founder House Rules",
      },
      orderBy: { updatedAt: "desc" },
    }),
    shouldLoadProducts
      ? prisma.product.findMany({
          where: { merchantId: merchant.id, shopId: shop.id },
          include: {
            variants: {
              orderBy: [{ sku: "asc" }, { title: "asc" }],
              include: {
                cogsInputs: {
                  where: { effectiveTo: null },
                  orderBy: { updatedAt: "desc" },
                  take: 1,
                },
              },
            },
          },
          orderBy: { title: "asc" },
          take: 50,
        })
      : Promise.resolve([]),
    calculateCogsCompletion(prisma, shop.id),
    getOnboardingState(prisma, shop.id),
  ]);

  return {
    task,
    shopDomain: shop.shopDomain,
    goals: goals.map((goal) => ({
      horizon: goal.horizon,
      description: goal.description,
      metadata: goal.metadata as Record<string, string | null>,
    })),
    houseRule: houseRule
      ? {
          structuredRules: houseRule.structuredRules as Record<string, unknown>,
          freeTextRules: houseRule.freeTextRules,
          maxDiscountBps: houseRule.maxDiscountBps,
          maxDefaultDiscountBps: houseRule.maxDefaultDiscountBps,
          maxWinbackDiscountBps: houseRule.maxWinbackDiscountBps,
          allowWinbackDiscountAboveDefault:
            houseRule.allowWinbackDiscountAboveDefault,
          maxCampaignAudienceSize: houseRule.maxCampaignAudienceSize,
          emailCooldownDays: houseRule.emailCooldownDays,
          emailFrequencyScope: houseRule.emailFrequencyScope,
          bfcmFreezeMode: houseRule.bfcmFreezeMode,
          emailFrequencyRules: houseRule.emailFrequencyRules as Record<
            string,
            string | number | null
          >,
          brandVoiceRules: houseRule.brandVoiceRules as Record<
            string,
            string | null
          >,
          marginPriorityRules: houseRule.marginPriorityRules as Record<
            string,
            string | number | null
          >,
          seasonalPriorities: houseRule.seasonalPriorities as Record<
            string,
            string[] | boolean | null
          >,
          riskyActionRules: houseRule.riskyActionRules as Record<
            string,
            string | null
          >,
        }
      : null,
    products: products.map((product) => ({
      id: product.id,
      title: product.title,
      shopifyAdminUrl: shopifyProductAdminUrl(
        shop.shopDomain,
        product.externalId,
      ),
      variants: product.variants.map((variant) => {
        const cogs = variant.cogsInputs[0];

        return {
          id: variant.id,
          productId: product.id,
          title: variant.title,
          sku: variant.sku,
          shopifyAdminUrl: shopifyVariantAdminUrl(
            shop.shopDomain,
            product.externalId,
            variant.externalId,
          ),
          price: variant.price === null ? "" : String(variant.price),
          costAmount: cogs ? String(cogs.costAmount) : "",
        };
      }),
    })),
    cogsStats,
    onboarding,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, redirect } = await authenticate.admin(request);
  const { merchant, shop } = await ensureOnboardingTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const url = new URL(request.url);
  const task = normalizeSettingsTask(url.searchParams.get("task"));
  const afterSave = task
    ? `/app/manager-settings?task=${task}`
    : "/app/manager-settings";

  if (intent === "save-goals") {
    await saveOnboardingGoals(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      goals: {
        THREE_MONTHS: String(formData.get("goalThreeMonths") ?? ""),
        SIX_MONTHS: String(formData.get("goalSixMonths") ?? ""),
        TWELVE_MONTHS: String(formData.get("goalTwelveMonths") ?? ""),
      },
    });

    throw redirect(afterSave);
  }

  if (intent === "save-house-rules") {
    try {
      await saveOnboardingHouseRules(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
        rules: {
          maxDefaultDiscountPercent: formData.get("maxDefaultDiscountPercent"),
          maxWinbackDiscountPercent: formData.get("maxWinbackDiscountPercent"),
          allowWinbackDiscountAboveDefault: formData.get(
            "allowWinbackDiscountAboveDefault",
          ),
          maxCampaignAudienceSize: formData.get("maxCampaignAudienceSize"),
          emailCooldownDays: formData.get("emailCooldownDays"),
          maxEmailsPerCustomer: formData.get("maxEmailsPerCustomer"),
          emailFrequencyScope: formData.get("emailFrequencyScope"),
          bfcmFreezeMode: formData.get("bfcmFreezeMode"),
          neverDiscountedSkus: formData.get("neverDiscountedSkus"),
          protectedProducts: formData.get("protectedProducts"),
          minimumMarginPercent: formData.get("minimumMarginPercent"),
          priorityMode: formData.get("priorityMode"),
          brandVoice: formData.get("brandVoice"),
          actionsRequiringExtraApproval: formData.get(
            "actionsRequiringExtraApproval",
          ),
          riskyPeriods: formData.get("riskyPeriods"),
          freeTextRules: formData.get("freeTextRules"),
        },
      });
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? error.message
            : "House Rules could not be saved.",
      };
    }

    throw redirect(afterSave);
  }

  if (intent === "save-cogs") {
    const variantIds = formData.getAll("variantId").map(String);
    await saveOnboardingCogsInputs(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      rows: variantIds.map((variantId) => ({
        variantId,
        productId: String(formData.get(`productId:${variantId}`) ?? ""),
        sku: String(formData.get(`sku:${variantId}`) ?? ""),
        costAmount: String(formData.get(`costAmount:${variantId}`) ?? ""),
      })),
    });

    throw redirect(afterSave);
  }

  if (intent === "set-approval-mode") {
    await saveOnboardingApprovalMode(prisma, {
      shopId: shop.id,
      approvalMode: String(formData.get("approvalMode") ?? ""),
    });

    throw redirect(afterSave);
  }

  return { ok: false, message: "Unknown settings action." };
};

export default function ManagerSettings() {
  const data = useLoaderData<typeof loader>();

  if (!data.task) {
    return <ManagerSettingsIndex data={data} />;
  }

  return <ManagerSettingsTask data={data as ManagerSettingsTaskData} />;
}

type ManagerSettingsData = Awaited<ReturnType<typeof loader>>;
type ManagerSettingsTaskData = ManagerSettingsData & { task: SettingsTask };

function ManagerSettingsTask({ data }: { data: ManagerSettingsTaskData }) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSubmitting = navigation.state === "submitting";
  const submittingIntent = navigation.formData?.get("intent");

  const goalsByHorizon = Object.fromEntries(
    data.goals.map((goal) => [goal.horizon, goal]),
  );
  const houseRule = data.houseRule;
  const structuredRules = houseRule?.structuredRules ?? {};
  const initialGoalsForm = {
    goalThreeMonths: goalsByHorizon.THREE_MONTHS?.description ?? "",
    goalSixMonths: goalsByHorizon.SIX_MONTHS?.description ?? "",
    goalTwelveMonths: goalsByHorizon.TWELVE_MONTHS?.description ?? "",
  };
  const [goalsForm, setGoalsForm] = useState(initialGoalsForm);
  const initialHouseRulesForm = {
    maxDefaultDiscountPercent: bpsToPercentString(
      houseRule?.maxDefaultDiscountBps ?? houseRule?.maxDiscountBps,
      HOUSE_RULE_DEFAULTS.maxDefaultDiscountPercent,
    ),
    maxWinbackDiscountPercent: bpsToPercentString(
      houseRule?.maxWinbackDiscountBps,
      HOUSE_RULE_DEFAULTS.maxWinbackDiscountPercent,
    ),
    allowWinbackDiscountAboveDefault:
      houseRule?.allowWinbackDiscountAboveDefault ??
      HOUSE_RULE_DEFAULTS.allowWinbackDiscountAboveDefault,
    maxCampaignAudienceSize: String(
      houseRule?.maxCampaignAudienceSize ??
        HOUSE_RULE_DEFAULTS.maxCampaignAudienceSize,
    ),
    emailCooldownDays: String(
      houseRule?.emailCooldownDays ?? HOUSE_RULE_DEFAULTS.emailCooldownDays,
    ),
    maxEmailsPerCustomer: String(
      houseRule?.emailFrequencyRules.maxEmailsPerCustomer ??
        HOUSE_RULE_DEFAULTS.maxEmailsPerCustomer,
    ),
    emailFrequencyScope:
      normalizeEmailFrequencyScope(houseRule?.emailFrequencyScope) ??
      HOUSE_RULE_DEFAULTS.emailFrequencyScope,
    bfcmFreezeMode:
      houseRule?.bfcmFreezeMode ?? HOUSE_RULE_DEFAULTS.bfcmFreezeMode,
    neverDiscountedSkus: arrayValue(structuredRules.neverDiscountedSkus),
    protectedProducts: arrayValue(structuredRules.protectedProducts),
    minimumMarginPercent: String(
      houseRule?.marginPriorityRules.minimumMarginPercent ??
        HOUSE_RULE_DEFAULTS.minimumMarginPercent,
    ),
    priorityMode: String(
      structuredRules.priorityMode ?? HOUSE_RULE_DEFAULTS.priorityMode,
    ),
    brandVoice: String(houseRule?.brandVoiceRules.voice ?? ""),
    actionsRequiringExtraApproval: textValue(
      houseRule?.riskyActionRules.actionsRequiringExtraApproval,
    ),
    riskyPeriods: arrayValue(houseRule?.seasonalPriorities.riskyPeriods),
    freeTextRules: houseRule?.freeTextRules ?? "",
  };
  const [houseRulesForm, setHouseRulesForm] = useState(initialHouseRulesForm);
  const [cogsDirty, setCogsDirty] = useState(false);
  const initialApprovalMode = String(data.onboarding.approvalMode ?? "");
  const [approvalMode, setApprovalMode] = useState(initialApprovalMode);
  const goalsDirty = formChanged(goalsForm, initialGoalsForm);
  const houseRulesDirty =
    houseRule === null ||
    fieldsChanged(houseRulesForm, initialHouseRulesForm, houseRulesFields);
  const brandVoiceDirty = fieldsChanged(
    houseRulesForm,
    initialHouseRulesForm,
    brandVoiceFields,
  );
  const protectedProductsDirty = fieldsChanged(
    houseRulesForm,
    initialHouseRulesForm,
    protectedProductFields,
  );
  const approvalModeDirty =
    approvalMode !== "" && approvalMode !== initialApprovalMode;
  const updateGoalField = (field: keyof typeof goalsForm, value: string) => {
    setGoalsForm((current) => ({ ...current, [field]: value }));
  };
  const applyGoalExample = (field: keyof typeof goalsForm, value: string) => {
    if (!value) return;
    updateGoalField(field, value);
  };
  const updateHouseRuleField = (
    field: keyof typeof houseRulesForm,
    value: string | boolean,
  ) => {
    setHouseRulesForm((current) => ({ ...current, [field]: value }));
  };
  const submitHouseRules = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!event.currentTarget.reportValidity()) return;

    const formData = new FormData();
    formData.set("intent", "save-house-rules");

    for (const [field, value] of Object.entries(houseRulesForm)) {
      formData.set(field, String(value));
    }

    submit(formData, { method: "post" });
  };

  return (
    <Page fullWidth>
      <div className={styles.briefing}>
        <BlockStack gap="500">
                {actionData ? (
                  <Banner tone={actionData.ok ? "success" : "critical"}>
                    <Text as="p" variant="bodyMd">
                      {actionData.message}
                    </Text>
                  </Banner>
                ) : null}

                {data.task === "goal" ? (
                  <Form method="post">
                    <BlockStack gap="500">
                      <SettingsTaskHeader
                        title={taskPageTitle(data.task)}
                        subtitle={taskPageSubtitle(data.task)}
                        primaryLabel="Save"
                        primaryLoading={
                          isSubmitting && submittingIntent === "save-goals"
                        }
                        primaryDisabled={!goalsDirty}
                      />
                      <Card>
                        <BlockStack gap="400">
                          <input
                            type="hidden"
                            name="intent"
                            value="save-goals"
                          />
                          <FormLayout>
                            <Select
                              label="3 month goal starting point"
                              options={goalExampleOptions.THREE_MONTHS}
                              value=""
                              onChange={(value) =>
                                applyGoalExample("goalThreeMonths", value)
                              }
                            />
                            <TextField
                              name="goalThreeMonths"
                              label="3 month goal"
                              value={goalsForm.goalThreeMonths}
                              onChange={(value) =>
                                updateGoalField("goalThreeMonths", value)
                              }
                              multiline={3}
                              autoComplete="off"
                            />
                            <Select
                              label="6 month goal starting point"
                              options={goalExampleOptions.SIX_MONTHS}
                              value=""
                              onChange={(value) =>
                                applyGoalExample("goalSixMonths", value)
                              }
                            />
                            <TextField
                              name="goalSixMonths"
                              label="6 month goal"
                              value={goalsForm.goalSixMonths}
                              onChange={(value) =>
                                updateGoalField("goalSixMonths", value)
                              }
                              multiline={3}
                              autoComplete="off"
                            />
                            <Select
                              label="12 month goal starting point"
                              options={goalExampleOptions.TWELVE_MONTHS}
                              value=""
                              onChange={(value) =>
                                applyGoalExample("goalTwelveMonths", value)
                              }
                            />
                            <TextField
                              name="goalTwelveMonths"
                              label="12 month goal"
                              value={goalsForm.goalTwelveMonths}
                              onChange={(value) =>
                                updateGoalField("goalTwelveMonths", value)
                              }
                              multiline={3}
                              autoComplete="off"
                            />
                          </FormLayout>
                        </BlockStack>
                      </Card>
                    </BlockStack>
                  </Form>
                ) : null}

                {data.task === "house-rules" ? (
                  <Form method="post" onSubmit={submitHouseRules}>
                    <BlockStack gap="500">
                      <SettingsTaskHeader
                        title={taskPageTitle(data.task)}
                        subtitle={taskPageSubtitle(data.task)}
                        primaryLabel="Save"
                        primaryLoading={
                          isSubmitting &&
                          submittingIntent === "save-house-rules"
                        }
                        primaryDisabled={!houseRulesDirty}
                      />
                      <input
                        type="hidden"
                        name="intent"
                        value="save-house-rules"
                      />
                      <HiddenHouseRulesFields
                        form={houseRulesForm}
                        exclude={houseRulesFields}
                      />
                      <HouseRulesFields
                        form={houseRulesForm}
                        updateField={(field, value) =>
                          updateHouseRuleField(
                            field as keyof typeof houseRulesForm,
                            value,
                          )
                        }
                      />
                    </BlockStack>
                  </Form>
                ) : null}

                {data.task === "brand-voice" ? (
                  <Form method="post" onSubmit={submitHouseRules}>
                    <BlockStack gap="500">
                      <SettingsTaskHeader
                        title={taskPageTitle(data.task)}
                        subtitle={taskPageSubtitle(data.task)}
                        primaryLabel="Save"
                        primaryLoading={
                          isSubmitting &&
                          submittingIntent === "save-house-rules"
                        }
                        primaryDisabled={!brandVoiceDirty}
                      />
                      <input
                        type="hidden"
                        name="intent"
                        value="save-house-rules"
                      />
                      <HiddenHouseRulesFields
                        form={houseRulesForm}
                        exclude={brandVoiceFields}
                      />
                      <Card>
                        <BlockStack gap="400">
                          <BlockStack gap="100">
                            <Text as="h2" variant="headingMd">
                              Brand voice
                            </Text>
                            <Text as="p" variant="bodyMd" tone="subdued">
                              Describe how Jefe should sound when drafting
                              future email and campaign copy.
                            </Text>
                          </BlockStack>
                          <FormLayout>
                            <TextField
                              name="brandVoice"
                              label="Voice guidance"
                              placeholder="Example: Premium, helpful, not gimmicky. Avoid sounding cheap or desperate."
                              value={houseRulesForm.brandVoice}
                              onChange={(value) =>
                                updateHouseRuleField("brandVoice", value)
                              }
                              multiline={4}
                              autoComplete="off"
                            />
                          </FormLayout>
                        </BlockStack>
                      </Card>
                    </BlockStack>
                  </Form>
                ) : null}

                {data.task === "protected-products" ? (
                  <Form method="post" onSubmit={submitHouseRules}>
                    <BlockStack gap="500">
                      <SettingsTaskHeader
                        title={taskPageTitle(data.task)}
                        subtitle={taskPageSubtitle(data.task)}
                        primaryLabel="Save"
                        primaryLoading={
                          isSubmitting &&
                          submittingIntent === "save-house-rules"
                        }
                        primaryDisabled={!protectedProductsDirty}
                      />
                      <input
                        type="hidden"
                        name="intent"
                        value="save-house-rules"
                      />
                      <HiddenHouseRulesFields
                        form={houseRulesForm}
                        exclude={protectedProductFields}
                      />
                      <Card>
                        <BlockStack gap="400">
                          <BlockStack gap="100">
                            <Text as="h2" variant="headingMd">
                              Protected products
                            </Text>
                            <Text as="p" variant="bodyMd" tone="subdued">
                              List products, SKUs or collections Jefe should
                              not discount casually.
                            </Text>
                          </BlockStack>
                          <FormLayout>
                            <TextField
                              name="neverDiscountedSkus"
                              label="Never discounted products or SKUs"
                              placeholder="Example: Hero Hoodie, Gift Cards, New Season Collection"
                              value={houseRulesForm.neverDiscountedSkus}
                              onChange={(value) =>
                                updateHouseRuleField(
                                  "neverDiscountedSkus",
                                  value,
                                )
                              }
                              multiline={3}
                              autoComplete="off"
                            />
                            <TextField
                              name="protectedProducts"
                              label="Protected hero products"
                              placeholder="Example: Black Hoodie, Red Sneakers, Core Collection"
                              value={houseRulesForm.protectedProducts}
                              onChange={(value) =>
                                updateHouseRuleField(
                                  "protectedProducts",
                                  value,
                                )
                              }
                              multiline={3}
                              autoComplete="off"
                            />
                          </FormLayout>
                        </BlockStack>
                      </Card>
                    </BlockStack>
                  </Form>
                ) : null}

                {data.task === "product-costs" ? (
                  <Form method="post">
                    <BlockStack gap="500">
                      <SettingsTaskHeader
                        title={taskPageTitle(data.task)}
                        subtitle={taskPageSubtitle(data.task)}
                        primaryLabel="Save"
                        primaryLoading={
                          isSubmitting && submittingIntent === "save-cogs"
                        }
                        primaryDisabled={!cogsDirty}
                      />
                      <Card>
                        <BlockStack gap="400">
                          <input
                            type="hidden"
                            name="intent"
                            value="save-cogs"
                          />
                          <Banner
                            tone={
                              data.cogsStats.confidenceLevel === "low"
                                ? "warning"
                                : "info"
                            }
                          >
                            <Text as="p" variant="bodyMd">
                              Product costs are recommended, not required.
                              Margin confidence is based on sold revenue with
                              confirmed or merchant-rule costs.
                            </Text>
                          </Banner>
                          {data.products.length === 0 ? (
                            <Text as="p" variant="bodyMd" tone="subdued">
                              Product costs can be entered once products are
                              available.
                            </Text>
                          ) : (
                            <CogsProductsTable
                              products={data.products}
                              onDirtyChange={setCogsDirty}
                            />
                          )}
                        </BlockStack>
                      </Card>
                    </BlockStack>
                  </Form>
                ) : null}

                {data.task === "approval-mode" ? (
                  <Form method="post">
                    <BlockStack gap="500">
                      <SettingsTaskHeader
                        title={taskPageTitle(data.task)}
                        subtitle={taskPageSubtitle(data.task)}
                        primaryLabel="Save"
                        primaryLoading={
                          isSubmitting &&
                          submittingIntent === "set-approval-mode"
                        }
                        primaryDisabled={!approvalModeDirty}
                      />
                      <Card>
                        <BlockStack gap="400">
                          <input
                            type="hidden"
                            name="intent"
                            value="set-approval-mode"
                          />
                          <input
                            type="hidden"
                            name="approvalMode"
                            value={approvalMode}
                          />
                          <Select
                            label="Approval mode"
                            options={approvalModeOptions}
                            value={approvalMode}
                            onChange={setApprovalMode}
                          />
                          <Banner tone="info">
                            <Text as="p" variant="bodyMd">
                              {approvalModeDescription(approvalMode)}
                            </Text>
                          </Banner>
                        </BlockStack>
                      </Card>
                    </BlockStack>
                  </Form>
                ) : null}
        </BlockStack>
      </div>
    </Page>
  );
}

function ManagerSettingsIndex({ data }: { data: ManagerSettingsData }) {
  const summary = [
    {
      label: "Goals",
      value: data.onboarding.requiredSetup.find((step) => step.key === "goals")
        ?.complete
        ? "Complete"
        : "Needs review",
      tone: data.onboarding.requiredSetup.find((step) => step.key === "goals")
        ?.complete
        ? "success"
        : "attention",
    },
    {
      label: "House Rules",
      value: data.onboarding.requiredSetup.find(
        (step) => step.key === "house_rules",
      )?.complete
        ? "Complete"
        : "Needs review",
      tone: data.onboarding.requiredSetup.find(
        (step) => step.key === "house_rules",
      )?.complete
        ? "success"
        : "attention",
    },
    {
      label: "Approval",
      value: approvalModeSummary(data.onboarding.approvalMode),
      tone: data.onboarding.approvalMode ? "info" : "attention",
    },
    {
      label: "Costs",
      value:
        data.cogsStats.confidenceLevel === "low" ? "Limited" : "Ready",
      tone: data.cogsStats.confidenceLevel === "low" ? "warning" : "success",
    },
  ] as const;
  const settings = [
    {
      title: "Business goals",
      description: "Edit the 3, 6 and 12 month goals Jefe should work toward.",
      href: "/app/manager-settings?task=goal",
      action: "Edit goals",
      status: summary[0].value,
    },
    {
      title: "House Rules",
      description: "Edit margin, discount, messaging and approval guardrails.",
      href: "/app/manager-settings?task=house-rules",
      action: "Edit rules",
      status: summary[1].value,
    },
    {
      title: "Approval mode",
      description: "Choose how cautious Jefe should be with recommendations.",
      href: "/app/manager-settings?task=approval-mode",
      action: "Change mode",
      status: summary[2].value,
    },
    {
      title: "Product costs",
      description: "Maintain COGS coverage for margin confidence.",
      href: "/app/manager-settings?task=product-costs",
      action: "Review product costs",
      status: `${data.cogsStats.completionPercentage}% coverage`,
    },
    {
      title: "Brand voice",
      description: "Edit copy and campaign voice guidance.",
      href: "/app/manager-settings?task=brand-voice",
      action: "Edit brand voice",
      status: data.onboarding.steps.find((step) => step.key === "brand_voice")
        ?.status === "complete"
        ? "Complete"
        : "Optional",
    },
    {
      title: "Protected products",
      description: "Edit products, SKUs or collections Jefe should protect.",
      href: "/app/manager-settings?task=protected-products",
      action: "Edit protected products",
      status: data.onboarding.steps.find(
        (step) => step.key === "protected_products",
      )?.status === "complete"
        ? "Complete"
        : "Optional",
    },
    {
      title: "Klaviyo",
      description: "Connect or review winback setup.",
      href: "/app/klaviyo-winback",
      action: "Manage Klaviyo",
      status: data.onboarding.moduleReadiness.find(
        (module) => module.key === "klaviyo_winback",
      )?.status ?? "Not connected",
    },
  ];

  return (
    <Page fullWidth>
      <div className={styles.briefing}>
        <header className={styles.header}>
          <Text as="h1" variant="heading2xl">
            Manager Settings
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            Teach Jefe how to manage your store.
          </Text>
          <div className={styles.statusRow}>
            {summary.map((item) => (
              <Badge key={item.label} tone={item.tone}>
                {`${item.label} ${item.value}`}
              </Badge>
            ))}
          </div>
        </header>

        <section className={styles.verdict}>
          <h2 className={styles.verdictTitle}>
            These settings control what Jefe recommends.
          </h2>
          <p className={styles.verdictBody}>
            Jefe uses your goals, House Rules, approval comfort and product
            costs to decide what it recommends, what it blocks, and when it asks
            for approval.
          </p>
        </section>

        <section className={styles.actionCard}>
          <p className={styles.eyebrow}>Primary action</p>
          <h3 className={styles.actionTitle}>
            {primarySettingsAction(data).title}
          </h3>
          <p className={styles.actionReason}>
            {primarySettingsAction(data).reason}
          </p>
          <div className={styles.actionButtonRow}>
            <Button variant="primary" url={primarySettingsAction(data).href}>
              {primarySettingsAction(data).label}
            </Button>
          </div>
        </section>

        <section className={styles.keyNumbers}>
          <h3 className={styles.sectionTitle}>Setup summary</h3>
          <div className={styles.keyNumberGrid}>
            {summary.map((item) => (
              <MetricBlock
                key={item.label}
                label={item.label}
                value={item.value}
              />
            ))}
          </div>
        </section>

        <section className={styles.moduleList}>
          {settings.map((setting) => (
            <div className={styles.moduleRow} key={setting.title}>
              <div>
                <div className={styles.moduleTitle}>{setting.title}</div>
                <div className={styles.moduleDetail}>{setting.description}</div>
              </div>
              <div className={styles.moduleStatus}>{setting.status}</div>
              <div className={styles.moduleDetail}>
                {setting.title === "House Rules"
                  ? "Discounts, margin protection, email contact and risk periods"
                  : setting.title === "Product costs"
                    ? "Margin confidence depends on product costs"
                    : "Used in Jefe recommendations"}
              </div>
              <Button url={setting.href}>{setting.action}</Button>
            </div>
          ))}
        </section>
      </div>
    </Page>
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

function primarySettingsAction(data: ManagerSettingsData) {
  const incompleteRequired = data.onboarding.requiredSetup.find(
    (step) => !step.complete && step.href,
  );

  if (incompleteRequired) {
    return {
      title: incompleteRequired.label,
      reason: incompleteRequired.reason,
      href: incompleteRequired.href,
      label:
        incompleteRequired.key === "goals"
          ? "Set goals"
          : incompleteRequired.key === "house_rules"
            ? "Review rules"
            : "Confirm mode",
    };
  }

  if (data.cogsStats.confidenceLevel === "low") {
    return {
      title: "Review product costs",
      reason:
        "Margin confidence depends on product costs, especially for products driving sold revenue.",
      href: "/app/manager-settings?task=product-costs",
      label: "Review product costs",
    };
  }

  return {
    title: "Review House Rules",
    reason:
      "House Rules are the boundaries Jefe follows before recommending actions.",
    href: "/app/manager-settings?task=house-rules",
    label: "Review rules",
  };
}

function approvalModeSummary(mode: string | null) {
  if (mode === "very_cautious") return "Very cautious";
  if (mode === "balanced") return "Balanced";
  if (mode === "experimental") return "Experimental";
  return "Needs review";
}

function SettingsTaskHeader({
  title,
  subtitle,
  primaryLabel,
  primaryDisabled = false,
  primaryLoading = false,
}: {
  title: string;
  subtitle: string;
  primaryLabel: string;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <InlineStack align="space-between" blockAlign="start" gap="400" wrap={false}>
      <Box width="100%" maxWidth="720px">
        <BlockStack gap="100">
          <Text as="h1" variant="heading2xl">
            {title}
          </Text>
          <Text as="p" variant="bodyLg" tone="subdued">
            {subtitle}
          </Text>
        </BlockStack>
      </Box>
      <InlineStack gap="200">
        <Button onClick={() => navigate("/app/manager-settings")}>Back</Button>
        <Button
          submit
          variant="primary"
          loading={primaryLoading}
          disabled={primaryDisabled}
        >
          {primaryLabel}
        </Button>
      </InlineStack>
    </InlineStack>
  );
}

function HouseRulesFields({
  form,
  updateField,
}: {
  form: Record<string, string | boolean>;
  updateField: (field: string, value: string | boolean) => void;
}) {
  return (
    <>
      <Card>
        <BlockStack gap="400">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Margin and discounts
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Set the commercial guardrails Jefe must respect before it
              suggests growth or retention work.
            </Text>
          </BlockStack>
          <FormLayout>
            <FormLayout.Group condensed>
              <TextField
                name="maxDefaultDiscountPercent"
                label="Max default discount %"
                type="number"
                min={0}
                max={100}
                step={0.01}
                value={String(form.maxDefaultDiscountPercent)}
                helpText="The normal maximum discount Jefe can suggest."
                onChange={(value) =>
                  updateField("maxDefaultDiscountPercent", value)
                }
                autoComplete="off"
              />
              <TextField
                name="maxWinbackDiscountPercent"
                label="Max winback discount %"
                type="number"
                min={0}
                max={100}
                step={0.01}
                value={String(form.maxWinbackDiscountPercent)}
                helpText="The maximum discount for dormant-customer winback campaigns."
                onChange={(value) =>
                  updateField("maxWinbackDiscountPercent", value)
                }
                autoComplete="off"
              />
            </FormLayout.Group>
            <Checkbox
              label="Explicitly allow winback discount above the default cap"
              checked={Boolean(form.allowWinbackDiscountAboveDefault)}
              onChange={(checked) =>
                updateField("allowWinbackDiscountAboveDefault", checked)
              }
            />
            <input
              type="hidden"
              name="allowWinbackDiscountAboveDefault"
              value={String(form.allowWinbackDiscountAboveDefault)}
            />
            <FormLayout.Group condensed>
              <TextField
                name="minimumMarginPercent"
                label="Minimum margin preference %"
                type="number"
                min={0}
                max={100}
                step={0.01}
                value={String(form.minimumMarginPercent)}
                helpText="The minimum gross margin you generally want protected. Used later for recommendations."
                onChange={(value) => updateField("minimumMarginPercent", value)}
                autoComplete="off"
              />
              <Select
                name="priorityMode"
                label="Margin / growth priority"
                options={priorityModeOptions}
                value={String(form.priorityMode)}
                onChange={(value) => updateField("priorityMode", value)}
              />
            </FormLayout.Group>
          </FormLayout>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Messaging limits
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Keep campaigns useful without over-contacting customers or
              sending large audiences without extra confidence.
            </Text>
          </BlockStack>
          <FormLayout>
            <FormLayout.Group condensed>
              <TextField
                name="maxEmailsPerCustomer"
                label="Maximum emails per customer"
                type="number"
                min={1}
                step={1}
                value={String(form.maxEmailsPerCustomer)}
                helpText="For example: 1 email per customer every 7 days."
                onChange={(value) => updateField("maxEmailsPerCustomer", value)}
                autoComplete="off"
              />
              <Select
                name="emailFrequencyScope"
                label="Email frequency limit means"
                options={emailFrequencyScopeOptions}
                value={String(form.emailFrequencyScope)}
                onChange={(value) => updateField("emailFrequencyScope", value)}
              />
            </FormLayout.Group>
            <FormLayout.Group condensed>
              <TextField
                name="maxCampaignAudienceSize"
                label="Max campaign audience size before extra approval"
                type="number"
                min={1}
                step={1}
                value={String(form.maxCampaignAudienceSize)}
                helpText="Campaigns above this audience size require stronger confirmation."
                onChange={(value) =>
                  updateField("maxCampaignAudienceSize", value)
                }
                autoComplete="off"
              />
              <TextField
                name="emailCooldownDays"
                label="Customer/segment email cooldown period in days"
                type="number"
                min={1}
                step={1}
                value={String(form.emailCooldownDays)}
                helpText="Do not contact the same customer/segment again within this many days."
                onChange={(value) => updateField("emailCooldownDays", value)}
                autoComplete="off"
              />
            </FormLayout.Group>
          </FormLayout>
        </BlockStack>
      </Card>

      <Card>
        <BlockStack gap="400">
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">
              Approvals and risk periods
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              Define when Jefe should slow down, ask for stronger approval, or
              obey extra written rules.
            </Text>
          </BlockStack>
          <FormLayout>
            <Checkbox
              label="BFCM / freeze mode"
              checked={Boolean(form.bfcmFreezeMode)}
              onChange={(checked) => updateField("bfcmFreezeMode", checked)}
            />
            <input
              type="hidden"
              name="bfcmFreezeMode"
              value={String(form.bfcmFreezeMode)}
            />
            <TextField
              name="actionsRequiringExtraApproval"
              label="Actions needing extra approval"
              placeholder="Example: Any price change, any campaign over 500 customers, any discount above 15%."
              value={String(form.actionsRequiringExtraApproval)}
              onChange={(value) =>
                updateField("actionsRequiringExtraApproval", value)
              }
              multiline={2}
              autoComplete="off"
            />
            <TextField
              name="riskyPeriods"
              label="Risky periods / BFCM freeze"
              placeholder="Example: 1 Nov-2 Dec: no risky writes without explicit approval."
              value={String(form.riskyPeriods)}
              onChange={(value) => updateField("riskyPeriods", value)}
              multiline={2}
              autoComplete="off"
            />
            <TextField
              name="freeTextRules"
              label="Free-text House Rules"
              placeholder="Example: Prioritise margin over revenue. Always show preview, audience size, discount and expected value before approval."
              value={String(form.freeTextRules)}
              onChange={(value) => updateField("freeTextRules", value)}
              multiline={4}
              autoComplete="off"
            />
          </FormLayout>
        </BlockStack>
      </Card>
    </>
  );
}

type CogsProduct = {
  id: string;
  title: string;
  shopifyAdminUrl: string | null;
  variants: Array<{
    id: string;
    productId: string;
    title: string | null;
    sku: string | null;
    shopifyAdminUrl: string | null;
    price: string;
    costAmount: string;
  }>;
};

function CogsProductsTable({
  products,
  onDirtyChange,
}: {
  products: CogsProduct[];
  onDirtyChange: (dirty: boolean) => void;
}) {
  const initialCogsRows = Object.fromEntries(
    products.flatMap((product) =>
      product.variants.map((variant) => [
        variant.id,
        {
          costAmount: variant.costAmount,
        },
      ]),
    ),
  );
  const [cogsRows, setCogsRows] = useState(() => initialCogsRows);

  useEffect(() => {
    onDirtyChange(formChanged(cogsRows, initialCogsRows));
  }, [cogsRows, initialCogsRows, onDirtyChange]);

  const updateCogsRow = (variantId: string, value: string) => {
    setCogsRows((current) => ({
      ...current,
      [variantId]: {
        ...current[variantId],
        costAmount: value,
      },
    }));
  };

  return (
    <DataTable
      columnContentTypes={["text", "text", "text", "text", "numeric"]}
      headings={["Product", "Variant", "SKU", "Price", "Product cost"]}
      rows={products.flatMap((product) =>
        product.variants.map((variant) => [
          <ShopifyAdminLink
            key={`${variant.id}-product`}
            url={product.shopifyAdminUrl}
            label={product.title}
          />,
          <ShopifyAdminLink
            key={`${variant.id}-variant`}
            url={variant.shopifyAdminUrl}
            label={variant.title || "Default"}
          />,
          variant.sku || "-",
          variant.price || "-",
          <Fragment key={`${variant.id}-cost`}>
            <input type="hidden" name="variantId" value={variant.id} />
            <input
              type="hidden"
              name={`productId:${variant.id}`}
              value={variant.productId}
            />
            <input
              type="hidden"
              name={`sku:${variant.id}`}
              value={variant.sku ?? ""}
            />
            <Box maxWidth="120px">
              <TextField
                name={`costAmount:${variant.id}`}
                label="Product cost"
                labelHidden
                type="number"
                min={0}
                step={0.0001}
                value={cogsRows[variant.id]?.costAmount ?? ""}
                onChange={(value) => updateCogsRow(variant.id, value)}
                autoComplete="off"
              />
            </Box>
          </Fragment>,
        ]),
      )}
    />
  );
}

function ShopifyAdminLink({
  url,
  label,
}: {
  url: string | null;
  label: string;
}) {
  if (!url) {
    return (
      <Box width="100%">
        <Text as="span" variant="bodyMd">
          {label}
        </Text>
      </Box>
    );
  }

  return (
    <Box width="100%">
      <Link url={url} target="_blank">
        <InlineStack
          as="span"
          align="start"
          gap="050"
          blockAlign="center"
          wrap={false}
        >
          <Text as="span" variant="bodyMd">
            {label}
          </Text>
          <Box width="16px">
            <Icon source={ExternalSmallIcon} tone="interactive" />
          </Box>
        </InlineStack>
      </Link>
    </Box>
  );
}

function HiddenHouseRulesFields({
  form,
  exclude,
}: {
  form: Record<string, string | boolean>;
  exclude: readonly string[];
}) {
  const excludedFields = new Set(exclude);

  return (
    <>
      {Object.entries(form)
        .filter(([name]) => !excludedFields.has(name))
        .map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={String(value)} />
        ))}
    </>
  );
}

function fieldsChanged(
  current: Record<string, string | boolean>,
  initial: Record<string, string | boolean>,
  fields: readonly string[],
) {
  return fields.some((field) => current[field] !== initial[field]);
}

function formChanged(
  current: Record<string, string | boolean | { costAmount: string }>,
  initial: Record<string, string | boolean | { costAmount: string }>,
) {
  const keys = new Set([...Object.keys(current), ...Object.keys(initial)]);

  return Array.from(keys).some((key) => {
    const currentValue = current[key];
    const initialValue = initial[key];

    if (isCogsRow(currentValue) || isCogsRow(initialValue)) {
      return (
        (isCogsRow(currentValue) ? currentValue.costAmount : "") !==
        (isCogsRow(initialValue) ? initialValue.costAmount : "")
      );
    }

    return currentValue !== initialValue;
  });
}

function isCogsRow(value: unknown): value is { costAmount: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "costAmount" in value &&
    typeof value.costAmount === "string"
  );
}

function normalizeSettingsTask(value: string | null): SettingsTask | null {
  return settingsTasks.includes(value as SettingsTask)
    ? (value as SettingsTask)
    : null;
}

function taskPageTitle(task: SettingsTask) {
  const titles: Record<SettingsTask, string> = {
    goal: "Business goals",
    "house-rules": "House Rules",
    "approval-mode": "Approval mode",
    "product-costs": "Product costs",
    "brand-voice": "Brand voice",
    "protected-products": "Protected products",
  };

  return titles[task];
}

function taskPageSubtitle(task: SettingsTask) {
  const subtitles: Record<SettingsTask, string> = {
    goal: "Edit the 3, 6 and 12 month goals Jefe should work toward.",
    "house-rules":
      "Edit the boundaries Jefe must follow before recommending actions.",
    "approval-mode": "Choose how cautious Jefe should be with recommendations.",
    "product-costs":
      "Maintain product cost coverage for margin confidence.",
    "brand-voice": "Guide future email and campaign copy.",
    "protected-products": "Mark products Jefe should not discount casually.",
  };

  return subtitles[task];
}

function approvalModeDescription(mode: string) {
  if (mode === "very_cautious") {
    return "Very cautious keeps recommendations conservative and asks for stronger approval before sensitive drafts or larger actions.";
  }
  if (mode === "balanced") {
    return "Balanced keeps low-risk drafts available while sends and writes still need approval.";
  }
  if (mode === "experimental") {
    return "Experimental allows Jefe to surface bolder tests, while external writes still require approval.";
  }

  return "Choose how cautious Jefe should be when turning evidence into recommendations and action drafts.";
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function textValue(value: unknown) {
  if (Array.isArray(value)) return value.join("\n");
  return typeof value === "string" ? value : "";
}

function bpsToPercentString(value: number | null | undefined, fallback = "") {
  return value === null || value === undefined ? fallback : String(value / 100);
}

function normalizeEmailFrequencyScope(value: string | null | undefined) {
  if (value === "per_customer") return "per_customer_per_week";
  if (value === "per_segment") return "per_segment_per_week";
  if (value === "per_week") return "per_customer_per_week";
  return value;
}

function shopifyProductAdminUrl(
  shopDomain: string,
  externalId: string | null | undefined,
) {
  const productId = shopifyNumericId(externalId);

  if (!productId) return null;

  return `https://admin.shopify.com/store/${shopifyStoreHandle(
    shopDomain,
  )}/products/${productId}`;
}

function shopifyVariantAdminUrl(
  shopDomain: string,
  productExternalId: string | null | undefined,
  variantExternalId: string | null | undefined,
) {
  const productId = shopifyNumericId(productExternalId);
  const variantId = shopifyNumericId(variantExternalId);

  if (!productId || !variantId) return null;

  return `https://admin.shopify.com/store/${shopifyStoreHandle(
    shopDomain,
  )}/products/${productId}/variants/${variantId}`;
}

function shopifyNumericId(externalId: string | null | undefined) {
  if (!externalId) return null;

  const gidMatch = externalId.match(/\/Product\/(\d+)$/);
  if (gidMatch) return gidMatch[1];
  if (/^\d+$/.test(externalId)) return externalId;
  return null;
}

function shopifyStoreHandle(shopDomain: string) {
  return shopDomain.replace(/\.myshopify\.com$/i, "");
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
