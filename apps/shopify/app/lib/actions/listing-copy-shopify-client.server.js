// @ts-check

// Product-type write client for the `listing_copy` primitive. The injected `gqlClient` is a
// `ShopifyAdminGraphqlClient` (or anything with `.request(query, vars)`); the wire layer builds
// it from the merchant's offline token and injects it — the same injection the clearance and
// product-status clients use, so this stays unit-testable. Named operations so a test double
// can key on the op name. `userErrors` throw.
//
// Reuses scopes already granted (`read_products` + `write_products`) — no new consent.

import { ShopifyAdminGraphqlError } from "../shopify/admin-graphql.server.js";

const GET_PRODUCT_TYPE = `#graphql
  query ProductTypeRead($id: ID!) {
    product(id: $id) { id productType }
  }`;

const UPDATE_PRODUCT_TYPE = `#graphql
  mutation ProductTypeSet($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product { id productType }
      userErrors { field message }
    }
  }`;

/**
 * @param {{ request: (query: string, variables?: Record<string, unknown>) => Promise<any> }} gqlClient
 * @returns {{ getProductType: (productId: string) => Promise<string | null>, updateProductType: (productId: string, productType: string) => Promise<unknown> }}
 */
export function createListingCopyShopifyClient(gqlClient) {
  if (!gqlClient || typeof gqlClient.request !== "function") {
    throw new ShopifyAdminGraphqlError(
      "createListingCopyShopifyClient requires a gql client with request()",
    );
  }
  return {
    /**
     * Shopify returns an unset product type as "", never null — the adapter's compare-and-set
     * treats both as blank, so this passes the value through rather than normalising it away.
     * @param {string} productId
     * @returns {Promise<string | null>}
     */
    async getProductType(productId) {
      const data = await gqlClient.request(GET_PRODUCT_TYPE, { id: productId });
      return data?.product?.productType ?? null;
    },
    /**
     * @param {string} productId
     * @param {string} productType  "" clears it — that is the revert path, not an error.
     */
    async updateProductType(productId, productType) {
      const data = await gqlClient.request(UPDATE_PRODUCT_TYPE, {
        product: { id: productId, productType },
      });
      const result = data?.productUpdate;
      if (result?.userErrors?.length) {
        throw new ShopifyAdminGraphqlError(
          `productUpdate(productType) returned userErrors: ${JSON.stringify(result.userErrors)}`,
        );
      }
      return result?.product ?? null;
    },
  };
}
