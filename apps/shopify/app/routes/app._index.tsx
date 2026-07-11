import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export default function Index() {
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
      heading: "Feedback",
      body: "Merchant feedback on recommendations, briefs, and outcomes will be captured here.",
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
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
