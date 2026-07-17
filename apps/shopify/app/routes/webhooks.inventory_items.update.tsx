import type { ActionFunctionArgs } from "react-router";
import db from "../db.server";
import { handleShopifyWebhookRequest } from "../lib/ingestion/shopify/webhooks.server.js";

export const action = async ({ request }: ActionFunctionArgs) => {
  return handleShopifyWebhookRequest(db, request, {
    expectedTopic: "inventory_items/update",
  });
};
