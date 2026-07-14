import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Fragment, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigate,
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
  Checkbox,
  DataTable,
  FormLayout,
  InlineGrid,
  Layout,
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
  saveOnboardingCogsInputs,
  saveOnboardingGoals,
  saveOnboardingHouseRules,
} from "../services/onboarding.server";
import { HOUSE_RULE_DEFAULTS } from "../services/house-rules-policy";

const priorityOptions = [
  { label: "Choose priority", value: "" },
  { label: "Margin over volume", value: "margin" },
  { label: "Growth over margin", value: "growth" },
  { label: "Cash preservation", value: "cash" },
  { label: "Customer retention", value: "retention" },
];

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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const shouldLoadCogsProducts = url.searchParams.get("cogs") === "1";
  const { merchant, shop } = await ensureOnboardingTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
  });
  const [goals, houseRule, products, cogsStats] = await Promise.all([
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
  ]);

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

  if (intent === "save-goals") {
    await saveOnboardingGoals(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      goals: {
        THREE_MONTHS: String(formData.get("goalThreeMonths") ?? ""),
        SIX_MONTHS: String(formData.get("goalSixMonths") ?? ""),
        TWELVE_MONTHS: String(formData.get("goalTwelveMonths") ?? ""),
      },
      priority: String(formData.get("priority") ?? ""),
      worthPayingFor: String(formData.get("worthPayingFor") ?? ""),
    });

    return { ok: true, message: "Goals saved." };
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

    return { ok: true, message: "House Rules saved." };
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

    return { ok: true, message: "COGS inputs saved." };
  }

  if (intent === "complete-onboarding") {
    await completeOnboarding(prisma, shop.id);

    return { ok: true, message: "Onboarding marked complete." };
  }

  return { ok: false, message: "Unknown onboarding action." };
};

export default function Onboarding() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const goalsByHorizon = Object.fromEntries(
    data.goals.map((goal) => [goal.horizon, goal]),
  );
  const goalMetadata = data.goals[0]?.metadata ?? {};
  const houseRule = data.houseRule;
  const structuredRules = houseRule?.structuredRules ?? {};
  const cogsPercentage = Number(data.cogsStats.completionPercentage);

  const [goalsForm, setGoalsForm] = useState({
    goalThreeMonths: goalsByHorizon.THREE_MONTHS?.description ?? "",
    goalSixMonths: goalsByHorizon.SIX_MONTHS?.description ?? "",
    goalTwelveMonths: goalsByHorizon.TWELVE_MONTHS?.description ?? "",
    priority: String(goalMetadata.priority ?? ""),
    worthPayingFor: String(goalMetadata.worthPayingFor ?? ""),
  });
  const [houseRulesForm, setHouseRulesForm] = useState({
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
  });
  const updateGoalField = (field: keyof typeof goalsForm, value: string) => {
    setGoalsForm((current) => ({ ...current, [field]: value }));
  };
  const updateHouseRuleField = (
    field: keyof typeof houseRulesForm,
    value: string | boolean,
  ) => {
    setHouseRulesForm((current) => ({ ...current, [field]: value }));
  };
  return (
    <Page>
      <BlockStack gap="500">
        <BlockStack gap="100">
          <Text as="h1" variant="heading2xl">
            Manager Settings
          </Text>
          <Text as="p" variant="bodyLg" tone="subdued">
            Goals, House Rules and cost assumptions for {data.shop.domain}.
          </Text>
        </BlockStack>

        <Card>
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd">
              Capture the goals, House Rules and cost assumptions Jefe needs
              before it can produce accountable recommendations for{" "}
              {data.shop.domain}.
            </Text>

            {actionData ? (
              <Banner tone={actionData.ok ? "success" : "critical"}>
                <Text as="p" variant="bodyMd">
                  {actionData.message}
                </Text>
              </Banner>
            ) : null}

            <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
              <ProgressItem
                label="Goals"
                complete={data.shop.goalsCompleted}
                detail={data.shop.goalsCompleted ? "Saved" : "Needs input"}
              />
              <ProgressItem
                label="House Rules"
                complete={data.shop.houseRulesCompleted}
                detail={
                  data.shop.houseRulesCompleted
                    ? "Saved"
                    : "Needs founder rules"
                }
              />
              <ProgressItem
                label="COGS"
                complete={cogsPercentage > 0}
                detail={`${data.cogsStats.completionPercentage}% ${data.cogsStats.confidenceLevel}`}
              />
              <ProgressItem
                label="Completion"
                complete={Boolean(data.shop.onboardingCompletedAt)}
                detail={
                  data.shop.onboardingCompletedAt
                    ? "Complete"
                    : "Can save and continue later"
                }
              />
            </InlineGrid>
          </BlockStack>
        </Card>

        <Layout>
          <Layout.AnnotatedSection
            title="Goals"
            description="The founder-defined outcomes Jefe should use to judge useful work."
          >
            <Card>
              <Form method="post">
                <BlockStack gap="400">
                  <input type="hidden" name="intent" value="save-goals" />
                  <FormLayout>
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
                    <Select
                      name="priority"
                      label="Current priority"
                      options={priorityOptions}
                      value={goalsForm.priority}
                      onChange={(value) => updateGoalField("priority", value)}
                    />
                    <TextField
                      name="worthPayingFor"
                      label="What would be worth paying for?"
                      value={goalsForm.worthPayingFor}
                      onChange={(value) =>
                        updateGoalField("worthPayingFor", value)
                      }
                      multiline={2}
                      autoComplete="off"
                    />
                  </FormLayout>
                  <Button submit variant="primary" loading={isSubmitting}>
                    Save goals
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="House Rules"
            description="Structured constraints for winback approvals plus the founder's free-text constitution."
          >
            <Card>
              <Form method="post">
                <BlockStack gap="400">
                  <Text as="p" variant="bodyMd">
                    House Rules are the rules Jefe must obey before
                    recommending or executing actions. These will be cited later
                    in every proposal, so you can see why an action was
                    suggested, capped, or blocked.
                  </Text>
                  <input type="hidden" name="intent" value="save-house-rules" />
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
                      name="allowWinbackDiscountAboveDefault"
                      label="Explicitly allow winback discount above the default cap"
                      checked={
                        houseRulesForm.allowWinbackDiscountAboveDefault
                      }
                      onChange={(checked) =>
                        updateHouseRuleField(
                          "allowWinbackDiscountAboveDefault",
                          checked,
                        )
                      }
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
                          updateHouseRuleField(
                            "maxCampaignAudienceSize",
                            value,
                          )
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
                    <Checkbox
                      name="bfcmFreezeMode"
                      label="BFCM / freeze mode"
                      checked={houseRulesForm.bfcmFreezeMode}
                      onChange={(checked) =>
                        updateHouseRuleField("bfcmFreezeMode", checked)
                      }
                    />
                    <TextField
                      name="neverDiscountedSkus"
                      label="Never discounted products or SKUs"
                      placeholder="Example: Hero Hoodie, Gift Cards, New Season Collection"
                      value={houseRulesForm.neverDiscountedSkus}
                      onChange={(value) =>
                        updateHouseRuleField("neverDiscountedSkus", value)
                      }
                      multiline={2}
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
                      multiline={2}
                      autoComplete="off"
                    />
                    <TextField
                      name="brandVoice"
                      label="Brand voice"
                      placeholder="Example: Premium, helpful, not gimmicky. Avoid sounding cheap or desperate."
                      value={houseRulesForm.brandVoice}
                      onChange={(value) =>
                        updateHouseRuleField("brandVoice", value)
                      }
                      multiline={2}
                      autoComplete="off"
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
                  <Button submit variant="primary" loading={isSubmitting}>
                    Save House Rules
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="COGS setup"
            description="Manual COGS inputs raise margin confidence; missing values remain allowed."
          >
            <Card>
              <Form method="post">
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
                        onClick={() => navigate("/app/onboarding?cogs=1")}
                        loading={navigation.state === "loading"}
                      >
                        Load COGS products
                      </Button>
                    </BlockStack>
                  ) : data.products.length === 0 ? (
                    <Text as="p" variant="bodyMd" tone="subdued">
                      Backfill Shopify products before entering COGS.
                    </Text>
                  ) : (
                    <CogsProductsTable products={data.products} />
                  )}
                  <Button
                    submit
                    variant="primary"
                    loading={
                      isSubmitting &&
                      navigation.formData?.get("intent") === "save-cogs"
                    }
                  >
                    Save COGS inputs
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          </Layout.AnnotatedSection>

          <Layout.AnnotatedSection
            title="Complete"
            description="Mark the setup flow complete once the founder has saved enough rules and cost context."
          >
            <Card>
              <Form method="post">
                <BlockStack gap="400">
                  <input
                    type="hidden"
                    name="intent"
                    value="complete-onboarding"
                  />
                  <Text as="p" variant="bodyMd">
                    Current COGS coverage is{" "}
                    {data.cogsStats.completionPercentage}% and the overall
                    confidence state is {data.cogsStats.confidenceLevel}.
                  </Text>
                  <Button
                    submit
                    variant="primary"
                    loading={
                      isSubmitting &&
                      navigation.formData?.get("intent") ===
                        "complete-onboarding"
                    }
                  >
                    Mark onboarding complete
                  </Button>
                </BlockStack>
              </Form>
            </Card>
          </Layout.AnnotatedSection>
        </Layout>
      </BlockStack>
    </Page>
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

function CogsProductsTable({ products }: { products: CogsProduct[] }) {
  const [cogsRows, setCogsRows] = useState(() =>
    Object.fromEntries(
      products.flatMap((product) =>
        product.variants.map((variant) => [
          variant.id,
          {
            costAmount: variant.costAmount,
          },
        ]),
      ),
    ),
  );

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

function ProgressItem({
  label,
  complete,
  detail,
}: {
  label: string;
  complete: boolean;
  detail: string;
}) {
  return (
    <Box
      aria-label={`${label}: ${complete ? "complete" : "incomplete"}`}
      background="bg-surface-secondary"
      borderColor="border"
      borderRadius="200"
      borderWidth="025"
      padding="400"
    >
      <BlockStack gap="200">
        <Badge tone={complete ? "success" : "attention"}>
          {complete ? "Complete" : "Incomplete"}
        </Badge>
        <Text as="h2" variant="headingMd">
          {label}
        </Text>
        <Text as="p" variant="bodyMd" tone="subdued">
          {detail}
        </Text>
      </BlockStack>
    </Box>
  );
}

function arrayValue(value: unknown) {
  return Array.isArray(value) ? value.join("\n") : "";
}

function textValue(value: unknown) {
  if (Array.isArray(value)) return value.join("\n");
  return typeof value === "string" ? value : "";
}

function bpsToPercentString(
  value: number | null | undefined,
  fallback = "",
) {
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
