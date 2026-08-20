// @ts-check

// Shopify GraphQL client for the `shopify_inventory_transfer` primitive. The
// typed adapter owns validation/idempotency/ledger; this small client only maps
// the already-approved preview into Shopify's inventoryTransferCreate mutation.

import { ShopifyAdminGraphqlError } from "../shopify/admin-graphql.server.js";

const CREATE_INVENTORY_TRANSFER = `#graphql
  mutation InventoryTransferCreate($input: InventoryTransferCreateInput!, $idempotencyKey: String!) {
    inventoryTransferCreate(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryTransfer {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }`;

/**
 * @param {{ request: (query: string, variables?: Record<string, unknown>) => Promise<any> }} gqlClient
 * @returns {{ createInventoryTransfer: (input: { originLocationId: string; destinationLocationId: string; lineItems: Array<{ inventoryItemId: string; quantity: number }>; idempotencyKey?: string }) => Promise<any> }}
 */
export function createInventoryTransferShopifyClient(gqlClient) {
  if (!gqlClient || typeof gqlClient.request !== "function") {
    throw new ShopifyAdminGraphqlError(
      "createInventoryTransferShopifyClient requires a gql client with request()",
    );
  }
  return {
    async createInventoryTransfer(input) {
      const data = await gqlClient.request(CREATE_INVENTORY_TRANSFER, {
        input: {
          originLocationId: input.originLocationId,
          destinationLocationId: input.destinationLocationId,
          lineItems: input.lineItems.map((item) => ({
            inventoryItemId: item.inventoryItemId,
            quantity: item.quantity,
          })),
        },
        idempotencyKey: input.idempotencyKey,
      });
      return data?.inventoryTransferCreate ?? null;
    },
  };
}
