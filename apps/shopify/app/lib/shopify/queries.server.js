// @ts-check

export const BULK_OPERATION_RUN_QUERY = `#graphql
  mutation JefeBulkOperationRun($query: String!) {
    bulkOperationRunQuery(query: $query) {
      bulkOperation {
        id
        status
        errorCode
        createdAt
        completedAt
        objectCount
        fileSize
        url
        partialDataUrl
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export const BULK_OPERATION_NODE_QUERY = `#graphql
  query JefeBulkOperationNode($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        createdAt
        completedAt
        objectCount
        fileSize
        url
        partialDataUrl
      }
    }
  }
`;

export const PRODUCTS_BULK_QUERY = `#graphql
  {
    products {
      edges {
        node {
          __typename
          id
          title
          handle
          status
          vendor
          productType
          tags
          createdAt
          updatedAt
          variants {
            edges {
              node {
                __typename
                id
                title
                sku
                price
                compareAtPrice
                inventoryManagement
                taxable
                requiresShipping
                createdAt
                updatedAt
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      }
    }
  }
`;

/** @param {number} days */
export function buildOrdersBulkQuery(days) {
  const boundedDays = Math.min(Math.max(days, 1), 365);
  const start = new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  return `#graphql
    {
      orders(query: "created_at:>=${start}") {
        edges {
          node {
            __typename
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
            customer {
              id
              email
            }
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
            lineItems {
              edges {
                node {
                  __typename
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
              __typename
              id
              createdAt
              note
              totalRefundedSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    }
  `;
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
  query JefeOrdersBackfill($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
          createdAt
          updatedAt
          processedAt
          email
          displayFinancialStatus
          displayFulfillmentStatus
          currencyCode
          customer {
            id
            email
            firstName
            lastName
            acceptsMarketing
            emailMarketingConsent {
              marketingState
            }
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
          refunds(first: 50) {
            id
            createdAt
            note
            totalRefundedSet {
              shopMoney {
                amount
                currencyCode
              }
            }
          }
        }
      }
    }
  }
`;

export const INVENTORY_ITEMS_QUERY = `#graphql
  query JefeInventoryBackfill($first: Int!, $after: String) {
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
          inventoryLevels(first: 100) {
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
                }
              }
            }
          }
        }
      }
    }
  }
`;
