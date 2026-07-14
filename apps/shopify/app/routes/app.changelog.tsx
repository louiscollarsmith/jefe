import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import {
  Badge,
  BlockStack,
  Box,
  Card,
  InlineStack,
  Layout,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { loadChangelog } from "../services/changelog.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return {
    entries: await loadChangelog(),
  };
};

export default function Changelog() {
  const { entries } = useLoaderData<typeof loader>();

  return (
    <Page title="Changelog">
      <Layout>
        <Layout.Section>
          <InlineStack align="center">
            <Box width="100%" maxWidth="860px">
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h1" variant="headingXl">
                    Changelog
                  </Text>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Product updates, fixes and internal improvements.
                  </Text>
                </BlockStack>

                <BlockStack gap="400">
                  {entries.map((entry) => (
                    <Card key={entry.date}>
                      <BlockStack gap="500">
                        <BlockStack gap="050">
                          <Text as="h2" variant="headingLg">
                            {entry.date}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {friendlyDate(entry.date)}
                          </Text>
                        </BlockStack>

                        <BlockStack gap="500">
                          {entry.sections.map((section) => (
                            <BlockStack key={section.category} gap="200">
                              <InlineStack align="start">
                                <Badge tone={badgeTone(section.category)}>
                                  {section.category}
                                </Badge>
                              </InlineStack>
                              <List type="bullet" gap="loose">
                                {section.items.map((item) => (
                                  <List.Item key={item}>
                                    <Text as="span" variant="bodyMd">
                                      {item}
                                    </Text>
                                  </List.Item>
                                ))}
                              </List>
                            </BlockStack>
                          ))}
                        </BlockStack>
                      </BlockStack>
                    </Card>
                  ))}
                </BlockStack>
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

function badgeTone(category: string) {
  if (category === "Added") return "success";
  if (category === "Fixed") return "critical";
  if (category === "Security" || category === "Removed") return "warning";

  return "info";
}

function friendlyDate(date: string) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London",
  }).format(new Date(`${date}T12:00:00.000Z`));
}
