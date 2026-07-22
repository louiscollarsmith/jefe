import type { HeadersFunction } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { Page, Text } from "@shopify/polaris";

export default function AppIndex() {
  return (
    <Page>
      <Text as="h1" variant="heading2xl">
        Jefe
      </Text>
    </Page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
