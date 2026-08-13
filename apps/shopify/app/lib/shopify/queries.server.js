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

/**
 * Where an order came from — first/last touch, referral code, landing page and UTMs.
 *
 * ⛔ DEFAULT OFF, and the flag guards the QUERY, not just the storage. `read_orders` (which
 * we already hold) is enough for the scope check, but customer journey data is customer
 * behavioural data and sits behind Shopify's protected-customer-data approval at the app
 * level. Requesting a field the app isn't approved for fails the WHOLE request — which
 * would take down order backfill for every store, not just attribution. So when the flag is
 * off the query is byte-identical to what it has always been, and the blast radius of
 * turning it on is one env var away from being turned back off.
 */
export function isOrderAttributionIngestEnabled() {
  return process.env.ORDER_ATTRIBUTION_INGEST_ENABLED === "true";
}

const ORDER_ATTRIBUTION_FIELDS = `
          customerJourneySummary {
            customerOrderIndex
            daysToConversion
            firstVisit {
              source
              referralCode
              landingPage
              occurredAt
              utmParameters {
                source
                medium
                campaign
              }
            }
            lastVisit {
              source
              referralCode
              landingPage
              occurredAt
              utmParameters {
                source
                medium
                campaign
              }
            }
          }`;

/**
 * The orders backfill query. A function rather than a constant because the attribution
 * block is conditional — see `isOrderAttributionIngestEnabled`. Read at call time, not at
 * module load, so a test can flip the flag without re-importing the module.
 */
export function buildOrdersQuery() {
  if (!isOrderAttributionIngestEnabled()) return ORDERS_QUERY;
  const anchor = "\n          email\n";
  // Splicing on a whitespace-exact anchor is brittle, and the brittle failure mode here is
  // the bad one: a silent no-op that leaves the flag on, the query unchanged, and every
  // attribution belief permanently starved with nothing to point at. Fail loudly instead.
  if (!ORDERS_QUERY.includes(anchor)) {
    throw new Error(
      "buildOrdersQuery: order-attribution anchor not found in ORDERS_QUERY — the query was reformatted and attribution would silently never be requested.",
    );
  }
  return ORDERS_QUERY.replace(anchor, `\n${ORDER_ATTRIBUTION_FIELDS}${anchor}`);
}

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
          # Discount IDENTITY, not just amount. totalDiscount tells us a store gives away
          # 14% of gross; only the code tells us WHICH offer did it, which is the difference
          # between a number and an explanation. discountApplications is a union — code,
          # automatic, manual and script discounts each name themselves differently.
          discountCodes
          discountApplications(first: 10) {
            nodes {
              allocationMethod
              targetType
              ... on DiscountCodeApplication {
                code
              }
              ... on AutomaticDiscountApplication {
                title
              }
              ... on ManualDiscountApplication {
                title
              }
              ... on ScriptDiscountApplication {
                title
              }
            }
          }
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
  query JefeBootstrapRecentOrders($first: Int!, $after: String, $query: String!, $lineItemsFirst: Int!) {
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
          lineItems(first: $lineItemsFirst) {
            pageInfo { hasNextPage endCursor }
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

export const BOOTSTRAP_ORDER_LINE_ITEMS_QUERY = `#graphql
  query JefeBootstrapOrderLineItems($id: ID!, $first: Int!, $after: String) {
    node(id: $id) {
      ... on Order {
        lineItems(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
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
`;

export const BOOTSTRAP_ACTIVE_PRODUCTS_QUERY = `#graphql
  query JefeBootstrapActiveProducts($first: Int!, $after: String, $query: String!) {
    products(first: $first, after: $after, query: $query, sortKey: UPDATED_AT) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id title handle status vendor productType descriptionHtml createdAt updatedAt
          seo { title description }
        }
      }
    }
  }
`;

export const BOOTSTRAP_PRODUCT_VARIANTS_QUERY = `#graphql
  query JefeBootstrapProductVariants($id: ID!, $first: Int!, $after: String) {
    node(id: $id) {
      ... on Product {
        variants(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id sku title price createdAt updatedAt
            product { id }
            inventoryItem { id unitCost { amount } }
          } }
        }
      }
    }
  }
`;

export const BOOTSTRAP_INVENTORY_LEVELS_QUERY = `#graphql
  query JefeBootstrapInventoryLevels($id: ID!, $first: Int!, $after: String) {
    node(id: $id) {
      ... on InventoryItem {
        inventoryLevels(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id updatedAt
            quantities(names: ["available", "committed", "incoming"]) { name quantity }
            location { id name }
          } }
        }
      }
    }
  }
`;
