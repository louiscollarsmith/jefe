// @ts-check

import { MAX_BACKFILL_DAYS } from "./backfill-window.server.js";

export const PRODUCT_VARIANTS_COUNT_QUERY = `#graphql
  query JefeProductVariantsCount {
    productVariantsCount(limit: null) {
      count
    }
  }
`;

export const CUSTOMERS_COUNT_QUERY = `#graphql
  query JefeCustomersCount {
    customersCount(limit: null) {
      count
    }
  }
`;

export const ORDERS_COUNT_QUERY = `#graphql
  query JefeOrdersCount($query: String!) {
    ordersCount(query: $query, limit: null) {
      count
    }
  }
`;

/** @param {number} days */
export function buildOrdersBackfillQueryFilter(days) {
  const boundedDays = Math.min(Math.max(days, 1), MAX_BACKFILL_DAYS);
  const start = new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  return `created_at:>=${start}`;
}

export const PRODUCTS_QUERY = `#graphql
  query JefeProductsBackfill($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          handle
          status
          vendor
          productType
          descriptionHtml
          seo {
            title
            description
          }
          createdAt
          updatedAt
          variants(first: 100) {
            edges {
              node {
                id
                sku
                title
                price
                createdAt
                updatedAt
                inventoryItem {
                  id
                  unitCost {
                    amount
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const INVENTORY_ITEMS_QUERY = `#graphql
  query JefeInventoryItemsBackfill($first: Int!, $after: String) {
    inventoryItems(first: $first, after: $after) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          updatedAt
          variant {
            id
          }
          inventoryLevels(first: 50) {
            edges {
              node {
                id
                updatedAt
                quantities(names: ["available", "committed", "incoming"]) {
                  name
                  quantity
                }
                location {
                  id
                  name
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const ORDERS_QUERY = `#graphql
  query JefeOrdersBackfill($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          createdAt
          processedAt
          updatedAt
          cancelledAt
          closedAt
          displayFinancialStatus
          displayFulfillmentStatus
          currencyCode
          tags
          sourceName
          email
          billingAddress {
            country
            province
            city
            zip
          }
          shippingAddress {
            country
            province
            city
            zip
          }
          currentSubtotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          currentTotalPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          currentTotalDiscountsSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          currentTotalTaxSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          totalShippingPriceSet {
            shopMoney {
              amount
              currencyCode
            }
          }
          lineItems(first: 100) {
            edges {
              node {
                id
                sku
                title
                variantTitle
                quantity
                originalUnitPriceSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountedTotalSet {
                  shopMoney {
                    amount
                    currencyCode
                  }
                }
                discountAllocations {
                  allocatedAmountSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                }
                product {
                  id
                }
                variant {
                  id
                }
              }
            }
          }
          refunds {
            id
            createdAt
            note
            totalRefundedSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            refundLineItems(first: 100) {
              edges {
                node {
                  quantity
                  subtotalSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  lineItem {
                    id
                    product {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Bootstrap deliberately reads a bounded, most-recent slice. `pageInfo` is
// part of the evidence contract: concentration/discount claims are eligible
// only when the requested window is complete, while a low-cover upper bound may
// be useful from a truncated slice.
export const BOOTSTRAP_RECENT_ORDERS_QUERY = `#graphql
  query JefeBootstrapRecentOrders($first: Int!, $after: String, $query: String!) {
    orders(first: $first, after: $after, query: $query, sortKey: PROCESSED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id name createdAt processedAt updatedAt cancelledAt closedAt
          displayFinancialStatus displayFulfillmentStatus currencyCode tags sourceName
          currentSubtotalPriceSet { shopMoney { amount currencyCode } }
          currentTotalPriceSet { shopMoney { amount currencyCode } }
          currentTotalDiscountsSet { shopMoney { amount currencyCode } }
          currentTotalTaxSet { shopMoney { amount currencyCode } }
          totalShippingPriceSet { shopMoney { amount currencyCode } }
          lineItems(first: 100) {
            pageInfo { hasNextPage }
            edges { node {
              id sku title variantTitle quantity
              originalUnitPriceSet { shopMoney { amount currencyCode } }
              discountedTotalSet { shopMoney { amount currencyCode } }
              discountAllocations { allocatedAmountSet { shopMoney { amount currencyCode } } }
              product { id }
              variant { id }
            } }
          }
        }
      }
    }
  }
`;

export const BOOTSTRAP_CATALOG_NODES_QUERY = `#graphql
  query JefeBootstrapCatalogNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      __typename
      ... on Product {
        id title handle status vendor productType descriptionHtml createdAt updatedAt
        seo { title description }
        variants(first: 250) {
          pageInfo { hasNextPage }
          edges { node {
            id sku title price createdAt updatedAt
            product { id }
            inventoryItem {
              id
              unitCost { amount }
              inventoryLevels(first: 250) {
                pageInfo { hasNextPage }
                edges { node {
                  id updatedAt
                  quantities(names: ["available", "committed", "incoming"]) { name quantity }
                  location { id name }
                } }
              }
            }
          } }
        }
      }
      ... on ProductVariant {
        id sku title price createdAt updatedAt
        product { id }
        inventoryItem {
          id
          unitCost { amount }
          inventoryLevels(first: 250) {
            pageInfo { hasNextPage }
            edges { node {
              id updatedAt
              quantities(names: ["available", "committed", "incoming"]) { name quantity }
              location { id name }
            } }
          }
        }
      }
    }
  }
`;
