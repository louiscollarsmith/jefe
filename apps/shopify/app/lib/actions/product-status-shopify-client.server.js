// @ts-check

// Product-status write client for the `product_status_change` primitive (archive / unarchive a
// product = set its ProductStatus). The injected `gqlClient` is a `ShopifyAdminGraphqlClient`
// (or anything with `.request(query, vars)`); the wire layer builds it from the merchant's
// offline token and injects it — the same injection the clearance client uses, so this stays
// unit-testable. Named operations so a test double can key on the op name. `userErrors` throw.
//
// Reuses scopes already granted (`read_products` + `write_products`) — no new consent.

import { ShopifyAdminGraphqlError } from "../shopify/admin-graphql.server.js";

const GET_PRODUCT_STATUS = `#graphql
  query ProductStatusRead($id: ID!) {
    product(id: $id) { id status }
  }`;

const UPDATE_PRODUCT_STATUS = `#graphql
  mutation ProductStatusSet($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id status }
      userErrors { field message }
    }
  }`;

/**
 * @param {{ request: (query: string, variables?: Record<string, unknown>) => Promise<any> }} gqlClient
 * @returns {{ getProductStatus: (productId: string) => Promise<string | null>, updateProductStatus: (productId: string, status: string) => Promise<unknown> }}
 */
export function createProductStatusShopifyClient(gqlClient) {
  if (!gqlClient || typeof gqlClient.request !== "function") {
    throw new ShopifyAdminGraphqlError("createProductStatusShopifyClient requires a gql client with request()");
  }
  return {
    /**
     * @param {string} productId
     * @returns {Promise<string | null>} "ACTIVE" | "ARCHIVED" | "DRAFT" | null
     */
    async getProductStatus(productId) {
      const data = await gqlClient.request(GET_PRODUCT_STATUS, { id: productId });
      return data?.product?.status ?? null;
    },
    /**
     * @param {string} productId
     * @param {string} status - ACTIVE | ARCHIVED | DRAFT
     */
    async updateProductStatus(productId, status) {
      const data = await gqlClient.request(UPDATE_PRODUCT_STATUS, { product: { id: productId, status } });
      const result = data?.productUpdate;
      if (result?.userErrors?.length) {
        throw new ShopifyAdminGraphqlError("Product status write: productUpdate userErrors", { errors: result.userErrors });
      }
      return result?.product ?? null;
    },
  };
}
