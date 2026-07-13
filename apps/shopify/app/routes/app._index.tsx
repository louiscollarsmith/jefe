import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  getDummyDataStatus,
  getDummyFixtureSummary,
  getMissingDummyDataScopes,
  seedDummyStoreData,
} from "../services/dummy-store-data.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const missingScopes = getMissingDummyDataScopes(session.scope);
  const dummyDataStatus = await getDummyDataStatus(admin, {
    skipExistingProductCheck: missingScopes.includes("read_products"),
  });

  return {
    shop: session.shop,
    dummyData: {
      enabled: process.env.ENABLE_DUMMY_STORE_LOADER === "true",
      missingScopes,
      status: dummyDataStatus,
      fixture: getDummyFixtureSummary(),
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent !== "seed-dummy-store-data") {
    return { ok: false, error: "Unknown action." };
  }

  if (process.env.ENABLE_DUMMY_STORE_LOADER !== "true") {
    return {
      ok: false,
      error: "Dummy store data loader is disabled for this environment.",
    };
  }

  const missingScopes = getMissingDummyDataScopes(session.scope);

  if (missingScopes.length > 0) {
    return {
      ok: false,
      error: `Dummy store data loader is missing Shopify scopes: ${missingScopes.join(
        ", ",
      )}. Update the app scopes and reinstall this store.`,
    };
  }

  try {
    const result = await seedDummyStoreData(admin, session.shop);

    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Dummy store data could not be loaded.",
    };
  }
};

export default function Index() {
  const { shop, dummyData } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting =
    navigation.state === "submitting" &&
    navigation.formData?.get("intent") === "seed-dummy-store-data";
  const seedButtonDisabled =
    !dummyData.enabled ||
    dummyData.status.seeded ||
    dummyData.missingScopes.length > 0 ||
    isSubmitting;
  const seedResult = actionData?.ok ? actionData.result : null;
  const sections = [
    {
      heading: "Daily Verdict",
      body: "Contribution margin, top winners, top losers, margin leaks, and missing data warnings will appear here.",
    },
    {
      heading: "Inventory Guardian",
      body: "Stockout dates, margin at risk, reorder quantities, and supplier draft actions will appear here.",
    },
    {
      heading: "Watchdog",
      body: "Refund spikes, conversion drops, stock anomalies, and suspicious operational changes will appear here.",
    },
    {
      heading: "Klaviyo Winback",
      body: "Dormant customer segments, holdout plans, campaign drafts, approval gates, and verified results will appear here.",
    },
    {
      heading: "Feedback Engine",
      body: "Merchant feedback on recommendations, briefs, and outcomes will be captured here.",
    },
    {
      heading: "House Rules + Goals",
      body: "Merchant goals, discount limits, brand rules, protected products, and rules consulted by proposals will appear here.",
    },
  ];

  return (
    <s-page heading="Today's Verdict">
      <s-section>
        <s-stack gap="base">
          <s-paragraph>
            AI Ecom Manager will open each day with what happened, what matters,
            the money at stake, the recommended action, and the evidence behind
            it.
          </s-paragraph>
          <s-grid
            gridTemplateColumns="repeat(auto-fit, minmax(240px, 1fr))"
            gap="base"
          >
            {sections.map((section) => (
              <s-box
                key={section.heading}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack gap="small">
                  <s-heading>{section.heading}</s-heading>
                  <s-paragraph>{section.body}</s-paragraph>
                </s-stack>
              </s-box>
            ))}
          </s-grid>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="MVP status">
        <s-paragraph>
          This scaffold is intentionally read-only. Shopify data sync,
          recommendations, approvals, and measured write loops will be added in
          later tickets.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="Dummy store data">
        <s-stack gap="base">
          <s-paragraph>
            Load Ticket 03 seed data into {shop}: {dummyData.fixture.productCount}{" "}
            products, {dummyData.fixture.variantCount} variants,{" "}
            {dummyData.fixture.orderCount} test orders, and{" "}
            {dummyData.fixture.refundCount} refund.
          </s-paragraph>

          {dummyData.status.seeded ? (
            <s-paragraph>
              Dummy data exists from {dummyData.status.seededAt}. The loader is
              disabled for this store to avoid duplicate fixture data.
            </s-paragraph>
          ) : null}

          {!dummyData.enabled ? (
            <s-paragraph>
              Set ENABLE_DUMMY_STORE_LOADER=true in the app environment to enable
              this dev-only write path.
            </s-paragraph>
          ) : null}

          {dummyData.missingScopes.length > 0 ? (
            <s-banner tone="critical">
              <s-paragraph>
                Missing Shopify scopes: {dummyData.missingScopes.join(", ")}.
                Update the app scopes and reinstall this store.
              </s-paragraph>
            </s-banner>
          ) : null}

          {actionData && !actionData.ok ? (
            <s-banner tone="critical">
              <s-paragraph>{actionData.error}</s-paragraph>
            </s-banner>
          ) : null}

          {seedResult ? (
            <s-banner tone="success">
              <s-paragraph>
                Loaded {seedResult.productsCreated} products,{" "}
                {seedResult.variantsCreated} variants,{" "}
                {seedResult.ordersCreated} orders, and{" "}
                {seedResult.refundsCreated} refund.
              </s-paragraph>
            </s-banner>
          ) : null}

          <Form method="post">
            <input
              type="hidden"
              name="intent"
              value="seed-dummy-store-data"
            />
            <s-button
              type="submit"
              variant="primary"
              disabled={seedButtonDisabled}
            >
              {isSubmitting ? "Loading data" : "Load dummy store data"}
            </s-button>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
