import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Fragment, type FormEvent, useEffect, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
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
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";

import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  calculateCogsCompletion,
  completeOnboarding,
  ensureOnboardingTenant,
  getOnboardingState,
  saveOnboardingApprovalMode,
  saveOnboardingCogsInputs,
  saveOnboardingGoals,
  saveOnboardingHouseRules,
  setOnboardingStepStatus,
} from "../services/onboarding.server";
import { getDailyBriefReadiness } from "../services/daily-brief-readiness.server";
import { HOUSE_RULE_DEFAULTS } from "../services/house-rules-policy";
import {
  BACKFILL_DOMAINS,
  getShopBackfillProgress,
  queueInstallShopifyBackfill,
  splitScopes,
} from "../services/shopify-backfill-status.server";

const BACKFILL_POLL_INTERVAL_MS = 5000;

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
    {
      label: "Choose a starting point",
      value: "",
    },
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
    {
      label: "Choose a starting point",
      value: "",
    },
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
    {
      label: "Choose a starting point",
      value: "",
    },
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

type FocusedRequiredStep = {
  key: string;
  label: string;
  complete: boolean;
  href: string;
  reason: string;
};

type FocusedOptionalStep = {
  key: string;
  label: string;
  description: string;
  status: string;
  href: string;
  skippable: boolean;
};

type FocusedOnboardingState = {
  requiredProgress: { completeSteps: number; totalSteps: number };
  requiredOnboardingComplete: boolean;
  requiredSetup: FocusedRequiredStep[];
  steps: FocusedOptionalStep[];
};

const onboardingTasks = [
  "goal",
  "house-rules",
  "approval-mode",
  "product-costs",
  "klaviyo",
  "brand-voice",
  "protected-products",
  "backfill",
] as const;

type OnboardingTask = (typeof onboardingTasks)[number];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const task = normalizeOnboardingTask(url.searchParams.get("task"));
  const shouldLoadCogsProducts =
    task === "product-costs" || url.searchParams.get("cogs") === "1";
  const { merchant, shop } = await ensureOnboardingTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
  });
  let setupProgress = await getShopBackfillProgress(prisma, {
    shopId: shop.id,
  });
  const hasBackfillRows =
    setupProgress &&
    (setupProgress.jobs.length > 0 ||
      Object.values(setupProgress.statuses).some(Boolean));

  if (setupProgress && !hasBackfillRows) {
    await queueInstallShopifyBackfill(prisma, {
      shopDomain: session.shop,
      sessionId: session.id,
      scopes: splitScopes(session.scope),
      rawPayload: { source: "onboarding_backfill_guard" },
    });
    setupProgress = await getShopBackfillProgress(prisma, {
      shopId: shop.id,
    });
  }

  const [goals, houseRule, products, cogsStats, onboarding] = await Promise.all(
    [
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
      shouldLoadCogsProducts
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
    ],
  );
  const shouldLoadBackfillProgress =
    task === "backfill" ||
    onboarding.onboardingComplete ||
    (!task && onboarding.requiredOnboardingComplete);
  const backfillProgress =
    shouldLoadBackfillProgress
      ? await buildBackfillProgressView(
          prisma,
          { merchantId: merchant.id, shopId: shop.id },
          await getDailyBriefReadiness(prisma, {
            merchantId: merchant.id,
            shopId: shop.id,
            shopDomain: session.shop,
            sessionId: session.id,
            scopes: session.scope?.split(",").filter(Boolean) ?? [],
            source: "onboarding_backfill_task",
            generateIfImportComplete: true,
          }),
        )
      : null;

  if (onboarding.onboardingComplete) {
    if (backfillProgress?.briefReady) {
      throw redirect("/app/daily-brief");
    }

    if (task !== "backfill") {
      throw redirect("/app/onboarding?task=backfill");
    }
  }

  return {
    shop: {
      id: shop.id,
      domain: shop.shopDomain,
      onboardingStartedAt: shop.onboardingStartedAt?.toISOString() ?? null,
      onboardingCompletedAt: shop.onboardingCompletedAt?.toISOString() ?? null,
      goalsCompleted: shop.goalsCompleted,
      houseRulesCompleted: shop.houseRulesCompleted,
      cogsCompletionPercentage: Number(shop.cogsCompletionPercentage),
      cogsConfidenceLevel: shop.cogsConfidenceLevel,
    },
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
      variants: product.variants.map((variant) => {
        const cogs = variant.cogsInputs[0];

        return {
          id: variant.id,
          productId: product.id,
          title: variant.title,
          sku: variant.sku,
          price: variant.price === null ? "" : String(variant.price),
          costAmount: cogs ? String(cogs.costAmount) : "",
        };
      }),
    })),
    cogsStats,
    cogsProductsLoaded: shouldLoadCogsProducts,
    onboarding,
    task,
    backfillProgress,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { merchant, shop } = await ensureOnboardingTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const url = new URL(request.url);
  const task = normalizeOnboardingTask(url.searchParams.get("task"));
  const afterSave = task ? "/app/onboarding" : `${url.pathname}${url.search}`;

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

  if (intent === "onboarding-step") {
    const stepAction = String(formData.get("stepAction") ?? "");

    await setOnboardingStepStatus(prisma, {
      shopId: shop.id,
      stepKey: String(formData.get("stepKey") ?? ""),
      status: stepAction === "skip" ? "skipped" : "complete",
      metadata: { source: "onboarding" },
    });

    throw redirect(afterSave);
  }

  if (intent === "complete-onboarding") {
    const onboarding = await getOnboardingState(prisma, shop.id);

    if (!onboarding.requiredOnboardingComplete) {
      return {
        ok: false,
        message: "Complete the required setup steps before opening the app.",
      };
    }

    await completeOnboarding(prisma, shop.id);

    const readiness = await getDailyBriefReadiness(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      shopDomain: session.shop,
      sessionId: session.id,
      scopes: session.scope?.split(",").filter(Boolean) ?? [],
      source: "complete_onboarding_backfill_guard",
      generateIfImportComplete: true,
    });

    throw redirect(
      readiness.briefReady ? "/app/daily-brief" : "/app/onboarding?task=backfill",
    );
  }

  return { ok: false, message: "Unknown onboarding action." };
};

export default function Onboarding() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
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
  const requiredHeaderSteps = (data.onboarding.requiredSetup ?? []).filter(
    (step) => step.key !== "store_review",
  );
  const requiredHeaderComplete =
    requiredHeaderSteps.length > 0 &&
    requiredHeaderSteps.every((step) => step.complete);
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

  useEffect(() => {
    if (
      data.task !== "backfill" ||
      data.backfillProgress?.briefReady
    ) {
      return;
    }

    const interval = setInterval(() => {
      revalidator.revalidate();
    }, BACKFILL_POLL_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [
    data.backfillProgress?.briefReady,
    data.task,
    revalidator,
  ]);

  return (
    <Page>
      <BlockStack gap="500">
        {!data.task ? (
          <InlineStack align="space-between" blockAlign="start" gap="400">
            <BlockStack gap="100">
              <Text as="h1" variant="heading2xl">
                Onboarding
              </Text>
              <Text as="p" variant="bodyLg" tone="subdued">
                Complete the below information to get your first Daily Brief.
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                These settings are not set in stone. You can edit them in
                Manager Settings whenever you want.
              </Text>
            </BlockStack>
            {requiredHeaderComplete ? (
              <Form method="post">
                <input
                  type="hidden"
                  name="intent"
                  value="complete-onboarding"
                />
                <Button submit variant="primary">
                  {data.backfillProgress?.briefReady ? "Complete" : "Continue"}
                </Button>
              </Form>
            ) : null}
          </InlineStack>
        ) : null}

        {!data.task ? (
          <FocusedOnboardingPanel onboarding={data.onboarding} />
        ) : null}

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
              <TaskPageHeader
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
                  <input type="hidden" name="intent" value="save-goals" />
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
              <TaskPageHeader
                title={taskPageTitle(data.task)}
                subtitle={taskPageSubtitle(data.task)}
                primaryLabel="Save"
                primaryLoading={
                  isSubmitting && submittingIntent === "save-house-rules"
                }
                primaryDisabled={!houseRulesDirty}
              />
              <input type="hidden" name="intent" value="save-house-rules" />
              <HiddenHouseRulesFields
                form={houseRulesForm}
                exclude={houseRulesFields}
              />
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
                        value={houseRulesForm.maxDefaultDiscountPercent}
                        helpText="The normal maximum discount Jefe can suggest."
                        onChange={(value) =>
                          updateHouseRuleField(
                            "maxDefaultDiscountPercent",
                            value,
                          )
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
                        value={houseRulesForm.maxWinbackDiscountPercent}
                        helpText="The maximum discount for dormant-customer winback campaigns."
                        onChange={(value) =>
                          updateHouseRuleField(
                            "maxWinbackDiscountPercent",
                            value,
                          )
                        }
                        autoComplete="off"
                      />
                    </FormLayout.Group>
                    <Checkbox
                      label="Explicitly allow winback discount above the default cap"
                      checked={houseRulesForm.allowWinbackDiscountAboveDefault}
                      onChange={(checked) =>
                        updateHouseRuleField(
                          "allowWinbackDiscountAboveDefault",
                          checked,
                        )
                      }
                    />
                    <input
                      type="hidden"
                      name="allowWinbackDiscountAboveDefault"
                      value={String(
                        houseRulesForm.allowWinbackDiscountAboveDefault,
                      )}
                    />
                    <FormLayout.Group condensed>
                      <TextField
                        name="minimumMarginPercent"
                        label="Minimum margin preference %"
                        type="number"
                        min={0}
                        max={100}
                        step={0.01}
                        value={houseRulesForm.minimumMarginPercent}
                        helpText="The minimum gross margin you generally want protected. Used later for recommendations."
                        onChange={(value) =>
                          updateHouseRuleField("minimumMarginPercent", value)
                        }
                        autoComplete="off"
                      />
                      <Select
                        name="priorityMode"
                        label="Margin / growth priority"
                        options={priorityModeOptions}
                        value={houseRulesForm.priorityMode}
                        onChange={(value) =>
                          updateHouseRuleField("priorityMode", value)
                        }
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
                        value={houseRulesForm.maxEmailsPerCustomer}
                        helpText="For example: 1 email per customer every 7 days."
                        onChange={(value) =>
                          updateHouseRuleField("maxEmailsPerCustomer", value)
                        }
                        autoComplete="off"
                      />
                      <Select
                        name="emailFrequencyScope"
                        label="Email frequency limit means"
                        options={emailFrequencyScopeOptions}
                        value={houseRulesForm.emailFrequencyScope}
                        onChange={(value) =>
                          updateHouseRuleField("emailFrequencyScope", value)
                        }
                      />
                    </FormLayout.Group>
                    <FormLayout.Group condensed>
                      <TextField
                        name="maxCampaignAudienceSize"
                        label="Max campaign audience size before extra approval"
                        type="number"
                        min={1}
                        step={1}
                        value={houseRulesForm.maxCampaignAudienceSize}
                        helpText="Campaigns above this audience size require stronger confirmation."
                        onChange={(value) =>
                          updateHouseRuleField("maxCampaignAudienceSize", value)
                        }
                        autoComplete="off"
                      />
                      <TextField
                        name="emailCooldownDays"
                        label="Customer/segment email cooldown period in days"
                        type="number"
                        min={1}
                        step={1}
                        value={houseRulesForm.emailCooldownDays}
                        helpText="Do not contact the same customer/segment again within this many days."
                        onChange={(value) =>
                          updateHouseRuleField("emailCooldownDays", value)
                        }
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
                      Define when Jefe should slow down, ask for stronger
                      approval, or obey extra written rules.
                    </Text>
                  </BlockStack>
                  <FormLayout>
                    <Checkbox
                      label="BFCM / freeze mode"
                      checked={houseRulesForm.bfcmFreezeMode}
                      onChange={(checked) =>
                        updateHouseRuleField("bfcmFreezeMode", checked)
                      }
                    />
                    <input
                      type="hidden"
                      name="bfcmFreezeMode"
                      value={String(houseRulesForm.bfcmFreezeMode)}
                    />
                    <TextField
                      name="actionsRequiringExtraApproval"
                      label="Actions needing extra approval"
                      placeholder="Example: Any price change, any campaign over 500 customers, any discount above 15%."
                      value={houseRulesForm.actionsRequiringExtraApproval}
                      onChange={(value) =>
                        updateHouseRuleField(
                          "actionsRequiringExtraApproval",
                          value,
                        )
                      }
                      multiline={2}
                      autoComplete="off"
                    />
                    <TextField
                      name="riskyPeriods"
                      label="Risky periods / BFCM freeze"
                      placeholder="Example: 1 Nov-2 Dec: no risky writes without explicit approval."
                      value={houseRulesForm.riskyPeriods}
                      onChange={(value) =>
                        updateHouseRuleField("riskyPeriods", value)
                      }
                      multiline={2}
                      autoComplete="off"
                    />
                    <TextField
                      name="freeTextRules"
                      label="Free-text House Rules"
                      placeholder="Example: Prioritise margin over revenue. Always show preview, audience size, discount and expected value before approval."
                      value={houseRulesForm.freeTextRules}
                      onChange={(value) =>
                        updateHouseRuleField("freeTextRules", value)
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

        {data.task === "brand-voice" ? (
          <Form method="post" onSubmit={submitHouseRules}>
            <BlockStack gap="500">
              <TaskPageHeader
                title={taskPageTitle(data.task)}
                subtitle={taskPageSubtitle(data.task)}
                primaryLabel="Save"
                primaryLoading={
                  isSubmitting && submittingIntent === "save-house-rules"
                }
                primaryDisabled={!brandVoiceDirty}
              />
              <input type="hidden" name="intent" value="save-house-rules" />
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
                      Describe how Jefe should sound when drafting future email
                      and campaign copy.
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
              <TaskPageHeader
                title={taskPageTitle(data.task)}
                subtitle={taskPageSubtitle(data.task)}
                primaryLabel="Save"
                primaryLoading={
                  isSubmitting && submittingIntent === "save-house-rules"
                }
                primaryDisabled={!protectedProductsDirty}
              />
              <input type="hidden" name="intent" value="save-house-rules" />
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
                      List products, SKUs or collections Jefe should not
                      discount casually.
                    </Text>
                  </BlockStack>
                  <FormLayout>
                    <TextField
                      name="neverDiscountedSkus"
                      label="Never discounted products or SKUs"
                      placeholder="Example: Hero Hoodie, Gift Cards, New Season Collection"
                      value={houseRulesForm.neverDiscountedSkus}
                      onChange={(value) =>
                        updateHouseRuleField("neverDiscountedSkus", value)
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
                        updateHouseRuleField("protectedProducts", value)
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
              <TaskPageHeader
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
                  <input type="hidden" name="intent" value="save-cogs" />
                  <Banner
                    tone={
                      data.cogsStats.confidenceLevel === "missing"
                        ? "warning"
                        : "info"
                    }
                  >
                    <Text as="p" variant="bodyMd">
                      Missing COGS is allowed. Jefe will show contribution
                      margin with lower confidence until costs are estimated or
                      confirmed.
                    </Text>
                  </Banner>
                  {!data.cogsProductsLoaded ? (
                    <BlockStack gap="300">
                      <Text as="p" variant="bodyMd" tone="subdued">
                        Product rows are loaded only when you are ready to edit
                        COGS, so onboarding opens quickly.
                      </Text>
                      <Button
                        onClick={() =>
                          navigate("/app/onboarding?task=product-costs&cogs=1")
                        }
                        loading={navigation.state === "loading"}
                      >
                        Load COGS products
                      </Button>
                    </BlockStack>
                  ) : data.products.length === 0 ? (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Product costs can be entered once products are available.
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
              <TaskPageHeader
                title={taskPageTitle(data.task)}
                subtitle={taskPageSubtitle(data.task)}
                primaryLabel="Save"
                primaryLoading={
                  isSubmitting && submittingIntent === "set-approval-mode"
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

        {data.task === "klaviyo" ? (
          <BlockStack gap="500">
            <TaskPageHeader
              title={taskPageTitle(data.task)}
              subtitle={taskPageSubtitle(data.task)}
              primaryLabel="Connect Klaviyo"
              primaryUrl="/app/klaviyo-winback"
            />
            <Card>
              <BlockStack gap="300">
                <Text as="p" variant="bodyMd">
                  Klaviyo connection stays on the dedicated winback page.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        ) : null}

        {data.task === "backfill" && data.backfillProgress ? (
          <BlockStack gap="500">
            <TaskPageHeader
              title={taskPageTitle(data.task)}
              subtitle={taskPageSubtitle(data.task)}
              primaryLabel={
                data.backfillProgress.briefReady ? "Complete" : "Continue"
              }
              primaryUrl="/app/daily-brief"
              primaryDisabled={!data.backfillProgress.briefReady}
            />

            <Card>
              <BlockStack gap="400">
                <InlineStack
                  align="space-between"
                  blockAlign="center"
                  gap="300"
                >
                  <BlockStack gap="050">
                    <Text as="h2" variant="headingMd">
                      Shopify data import
                    </Text>
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Each area updates as Shopify makes its data available.
                    </Text>
                  </BlockStack>
                </InlineStack>

                <BlockStack gap="150">
                  {data.backfillProgress.statuses.map((status) => (
                    <BackfillStatusRow key={status.domain} status={status} />
                  ))}
                </BlockStack>

                <Text as="p" variant="bodySm" tone="subdued">
                  Progress will update automatically.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        ) : null}
      </BlockStack>
    </Page>
  );
}

function TaskPageHeader({
  title,
  subtitle,
  primaryLabel,
  primaryDisabled = false,
  primaryLoading = false,
  primaryUrl,
}: {
  title: string;
  subtitle: string;
  primaryLabel: string;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
  primaryUrl?: string;
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
        <Button onClick={() => navigate("/app/onboarding")}>Back</Button>
        {primaryUrl ? (
          <Button
            onClick={() => navigate(primaryUrl)}
            variant="primary"
            disabled={primaryDisabled}
          >
            {primaryLabel}
          </Button>
        ) : (
          <Button
            submit
            variant="primary"
            loading={primaryLoading}
            disabled={primaryDisabled}
          >
            {primaryLabel}
          </Button>
        )}
      </InlineStack>
    </InlineStack>
  );
}

type BackfillProgress = NonNullable<
  Awaited<ReturnType<typeof loader>>["backfillProgress"]
>;
type BackfillStatus = BackfillProgress["statuses"][0];

function BackfillStatusRow({ status }: { status: BackfillStatus }) {
  return (
    <Box
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
      padding="300"
    >
      <InlineStack align="space-between" blockAlign="center" gap="300">
        <BlockStack gap="050">
          <Text as="p" variant="headingSm">
            {formatBackfillDomain(status.domain)}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {formatBackfillImportCount(status)}
          </Text>
          {status.fallbackUsed ? (
            <Text as="p" variant="bodySm" tone="subdued">
              Fallback import used
            </Text>
          ) : null}
          {status.lastError ? (
            <Text as="p" variant="bodySm" tone="critical">
              {status.lastError}
            </Text>
          ) : null}
        </BlockStack>
        <Badge tone={backfillStatusTone(status.status)}>
          {formatBackfillStatusLabel(status.status)}
        </Badge>
      </InlineStack>
    </Box>
  );
}

type CogsProduct = {
  id: string;
  title: string;
  variants: Array<{
    id: string;
    productId: string;
    title: string | null;
    sku: string | null;
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
      headings={["Product", "Variant", "SKU", "Price", "COGS"]}
      rows={products.flatMap((product) =>
        product.variants.map((variant) => [
          product.title,
          variant.title || "Default",
          variant.sku || "-",
          variant.price || "-",
          <Fragment key={`${variant.id}-cogs`}>
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
                label="COGS"
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

function FocusedOnboardingPanel({
  onboarding,
}: {
  onboarding: FocusedOnboardingState;
}) {
  const requiredTaskSteps = (onboarding.requiredSetup ?? []).filter(
    (step) => step.key !== "store_review",
  );
  const completeRequiredTaskSteps = requiredTaskSteps.filter(
    (step) => step.complete,
  ).length;
  const requiredTasksComplete =
    requiredTaskSteps.length > 0 &&
    completeRequiredTaskSteps === requiredTaskSteps.length;
  const [requiredExpandedOverride, setRequiredExpandedOverride] = useState<
    boolean | null
  >(null);
  const [optionalExpanded, setOptionalExpanded] = useState(true);
  const optionalSteps = onboarding.steps
    .filter((step) =>
      [
        "brand_voice",
        "klaviyo",
        "product_costs",
        "protected_products",
      ].includes(step.key),
    )
    .sort((a, b) => optionalStepOrder(a.key) - optionalStepOrder(b.key));

  const requiredExpanded = requiredExpandedOverride ?? !requiredTasksComplete;

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <CollapsibleSetupHeader
            title="Required setup"
            subtitle="Complete these inputs so Jefe can prepare your first Daily Brief."
            expanded={requiredExpanded}
            onToggle={() =>
              setRequiredExpandedOverride(
                (expanded) => !(expanded ?? !requiredTasksComplete),
              )
            }
          />
          {requiredExpanded ? (
            <BlockStack gap="150">
              {requiredTaskSteps.map((step) => (
                <FocusedRequiredStep key={step.key} step={step} />
              ))}
            </BlockStack>
          ) : null}
        </BlockStack>
      </Card>

      {requiredTasksComplete ? (
        <Card>
          <BlockStack gap="300">
            <CollapsibleSetupHeader
              title="Optional setup"
              subtitle="These settings are optional for now, but recommended once your first Daily Brief is ready."
              expanded={optionalExpanded}
              onToggle={() => setOptionalExpanded((expanded) => !expanded)}
            />
            {optionalExpanded ? (
              <BlockStack gap="150">
                {optionalSteps.map((step) => (
                  <FocusedOptionalStep key={step.key} step={step} />
                ))}
              </BlockStack>
            ) : null}
          </BlockStack>
        </Card>
      ) : null}
    </BlockStack>
  );
}

function CollapsibleSetupHeader({
  title,
  subtitle,
  expanded,
  onToggle,
}: {
  title: string;
  subtitle?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <InlineStack align="space-between" blockAlign="start" gap="300">
      <BlockStack gap="050">
        <Text as="h3" variant="headingMd">
          {title}
        </Text>
        {subtitle ? (
          <Text as="p" variant="bodySm" tone="subdued">
            {subtitle}
          </Text>
        ) : null}
      </BlockStack>
      <Button
        onClick={onToggle}
        disclosure={expanded ? "up" : "down"}
        ariaExpanded={expanded}
      >
        {expanded ? "Hide" : "Show"}
      </Button>
    </InlineStack>
  );
}

function FocusedRequiredStep({ step }: { step: FocusedRequiredStep }) {
  const navigate = useNavigate();

  return (
    <Box
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
      padding="300"
    >
      <InlineStack align="space-between" blockAlign="center" gap="300">
        <BlockStack gap="050">
          <InlineStack
            as="span"
            align="start"
            blockAlign="center"
            gap="100"
            wrap={false}
          >
            <Text as="span" variant="headingSm">
              {step.label}
            </Text>
            <Badge tone={step.complete ? "success" : "attention"}>
              {requiredStepStatusLabel(step)}
            </Badge>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {step.reason}
          </Text>
        </BlockStack>
        <InlineStack gap="200" blockAlign="center">
          <Button onClick={() => navigate(step.href)}>
            {setupButtonLabel(step)}
          </Button>
        </InlineStack>
      </InlineStack>
    </Box>
  );
}

function FocusedOptionalStep({ step }: { step: FocusedOptionalStep }) {
  const navigate = useNavigate();

  return (
    <Box
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
      padding="300"
    >
      <InlineStack align="space-between" blockAlign="center" gap="300">
        <BlockStack gap="050">
          <InlineStack
            as="span"
            align="start"
            blockAlign="center"
            gap="100"
            wrap={false}
          >
            <Text as="span" variant="headingSm">
              {step.label}
            </Text>
            <Badge
              tone={
                step.status === "complete"
                  ? "success"
                  : step.key === "product_costs"
                    ? "info"
                    : "attention"
              }
            >
              {optionalStepBadge(step)}
            </Badge>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {optionalStepDescription(step)}
          </Text>
        </BlockStack>
        <InlineStack gap="200">
          <Button onClick={() => navigate(step.href)}>
            {setupButtonLabel(step)}
          </Button>
        </InlineStack>
      </InlineStack>
    </Box>
  );
}

function setupButtonLabel(step: {
  key: string;
  complete?: boolean;
  status?: string;
}) {
  const prefix = step.complete || step.status === "complete" ? "Edit" : "Set";

  if (step.key === "business_goal") return `${prefix} goals`;
  if (step.key === "house_rules") return `${prefix} rules`;
  if (step.key === "approval_mode") return `${prefix} mode`;
  if (step.key === "product_costs") return `${prefix} costs`;
  if (step.key === "protected_products") return `${prefix} products`;
  if (step.key === "klaviyo")
    return step.status === "complete" ? "Edit Klaviyo" : "Connect Klaviyo";
  if (step.key === "brand_voice") return `${prefix} voice`;
  if (step.key === "first_daily_brief") return "Complete setup";
  return "Continue";
}

function optionalStepOrder(key: string) {
  const order: Record<string, number> = {
    product_costs: 0,
    klaviyo: 1,
    brand_voice: 2,
    protected_products: 3,
  };

  return order[key] ?? 99;
}

function optionalStepBadge(step: FocusedOptionalStep) {
  if (["complete", "skipped"].includes(step.status))
    return setupStepLabel(step.status);
  if (step.key === "product_costs") return "Recommended";
  return "Optional";
}

function optionalStepDescription(step: FocusedOptionalStep) {
  if (step.key === "product_costs") {
    return "Margin insights will be limited until costs are added.";
  }
  if (step.key === "klaviyo") {
    return "Prepare winback drafts. Live sends remain disabled.";
  }
  if (step.key === "brand_voice") {
    return "Guide future email and campaign copy.";
  }
  if (step.key === "protected_products") {
    return "Mark products Jefe should not discount casually.";
  }

  return step.description;
}

function requiredStepStatusLabel(step: FocusedRequiredStep) {
  if (step.complete) return "Complete";
  return "Not started";
}

function setupStepLabel(status: string) {
  if (status === "needs_attention") return "Needs attention";
  return formatStatus(status);
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

function formatStatus(status: string) {
  const display = status.replace(/_/g, " ");

  return display[0].toUpperCase() + display.slice(1);
}

async function buildBackfillProgressView(
  prisma: typeof import("../db.server").default,
  input: { merchantId: string; shopId: string },
  readiness: Awaited<ReturnType<typeof getDailyBriefReadiness>>,
) {
  return buildBackfillProgressViewFromCounts(
    readiness,
    await loadCurrentBackfillCounts(prisma, input),
  );
}

function buildBackfillProgressViewFromCounts(
  readiness: Awaited<ReturnType<typeof getDailyBriefReadiness>>,
  currentCounts: Record<string, number>,
) {
  const statuses = BACKFILL_DOMAINS.map((domain) => {
    const status = readiness.progress?.statuses[domain] ?? null;
    const metadata =
      status?.metadata && typeof status.metadata === "object"
        ? (status.metadata as Record<string, unknown>)
        : {};
    const recordsProcessed = Math.max(
      currentCounts[domain] ?? 0,
      status?.recordsProcessed ?? 0,
    );
    const totalRecordsEstimate =
      status?.totalRecordsEstimate ??
      (isBackfillStatusComplete(status?.status) && recordsProcessed > 0
        ? recordsProcessed
        : null);

    return {
      domain,
      status: status?.status ?? "queued",
      recordsProcessed,
      totalRecordsEstimate,
      lastError: status?.lastError ?? null,
      bulkOperationStatus: stringValue(metadata.bulkOperationStatus),
      bulkOperationObjectCount: numberValue(metadata.bulkOperationObjectCount),
      fallbackUsed: Boolean(metadata.fallbackUsed),
    };
  });

  return {
    statuses,
    importComplete: readiness.importComplete,
    briefReady: readiness.briefReady,
  };
}

async function loadCurrentBackfillCounts(
  prisma: typeof import("../db.server").default,
  input: { merchantId: string; shopId: string },
) {
  const [products, orders, customers, inventory, refunds] = await Promise.all([
    prisma.product.count({
      where: { merchantId: input.merchantId, shopId: input.shopId },
    }),
    prisma.order.count({
      where: { merchantId: input.merchantId, shopId: input.shopId },
    }),
    prisma.customerIdentity.count({
      where: { merchantId: input.merchantId, shopId: input.shopId },
    }),
    prisma.inventoryLevel.count({
      where: { merchantId: input.merchantId, shopId: input.shopId },
    }),
    prisma.refund.count({
      where: { merchantId: input.merchantId, shopId: input.shopId },
    }),
  ]);

  return {
    products,
    orders,
    customers,
    inventory,
    refunds,
  };
}

function backfillStatusTone(status: string) {
  if (["complete", "bulk_imported"].includes(status)) return "success";
  if (status === "queued") return "attention";
  return "info";
}

function formatBackfillStatusLabel(status: string) {
  if (status === "complete" || status === "bulk_imported") return "Completed";
  if (status === "queued") return "Queued";
  return "Importing";
}

function formatBackfillDomain(domain: string) {
  if (domain === "shop") return "Shop details";
  if (domain === "derived_metrics") return "Derived metrics";
  return formatStatus(domain);
}

function formatBackfillImportCount(status: BackfillStatus) {
  if (status.domain === "shop") {
    if (status.status === "complete" || status.status === "bulk_imported") {
      return "Store details connected";
    }

    return status.status === "queued"
      ? "Analysing store details"
      : "Checking store details";
  }

  if (status.domain === "webhooks") {
    if (status.status === "complete" || status.status === "bulk_imported") {
      return "Webhook subscriptions active";
    }

    return status.status === "queued"
      ? "Analysing webhook setup"
      : "Configuring webhook subscriptions";
  }

  const processed = status.recordsProcessed.toLocaleString("en-GB");
  const total =
    typeof status.totalRecordsEstimate === "number"
      ? status.totalRecordsEstimate.toLocaleString("en-GB")
      : null;

  if (status.status === "complete" || status.status === "bulk_imported") {
    return total ? `Imported ${processed} of ${total}` : `Imported ${processed}`;
  }

  if (status.status === "queued") {
    return "Analysing";
  }

  if (total) return `Importing ${processed} of ${total}`;

  return `Importing ${processed}`;
}

function isBackfillStatusComplete(status: string | null | undefined) {
  return status === "complete" || status === "bulk_imported";
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : null;
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

function normalizeOnboardingTask(value: string | null): OnboardingTask | null {
  return onboardingTasks.includes(value as OnboardingTask)
    ? (value as OnboardingTask)
    : null;
}

function taskPageTitle(task: OnboardingTask) {
  const titles: Record<OnboardingTask, string> = {
    goal: "Confirm your business goals",
    "house-rules": "Review House Rules",
    "approval-mode": "Confirm approval mode",
    "product-costs": "Add product costs",
    klaviyo: "Connect Klaviyo",
    "brand-voice": "Set brand voice",
    "protected-products": "Protect hero products",
    backfill: "Importing your shop data",
  };

  return titles[task];
}

function taskPageSubtitle(task: OnboardingTask) {
  const subtitles: Record<OnboardingTask, string> = {
    goal: "Choose whether Jefe should prioritise growth, margin, stock control or retention.",
    "house-rules":
      "Set the boundaries Jefe must follow before recommending actions.",
    "approval-mode": "Choose how cautious Jefe should be with recommendations.",
    "product-costs": "Margin insights will be limited until costs are added.",
    klaviyo:
      "Connect Klaviyo so Jefe can prepare winback drafts. Live sends remain disabled.",
    "brand-voice": "Guide future email and campaign copy.",
    "protected-products": "Mark products Jefe should not discount casually.",
    backfill:
      "Jefe is importing up to 365 days of Shopify history so your first Daily Brief can use recent orders, products, inventory, refunds and customer context.",
  };

  return subtitles[task];
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

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
