// @ts-check

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
  query JefeOrdersBackfill($first: Int!, $after: String) {
    orders(first: $first, after: $after, sortKey: UPDATED_AT) {
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
          displayFinancialStatus
          displayFulfillmentStatus
          currencyCode
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
