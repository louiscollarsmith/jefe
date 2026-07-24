# Synthetic Shopify Capability Report

The healthy synthetic store is generated through Shopify-supported commerce objects: products, variants, collections, customers, orders, transactions, inventory levels and refunds.

The following states should not be fabricated through live Shopify API writes because they either violate Shopify-owned relational integrity or are not reliably representable through supported Admin APIs:

- Truly orphaned order line items with invalid product or variant IDs.
- Truly orphaned inventory levels disconnected from inventory items.
- Arbitrarily backdated inventory `updatedAt` timestamps.
- Refund records that Shopify considers financially successful when no successful refund transaction exists.
- Corrupted Shopify-owned IDs, timestamps or relationship pointers.
- Production-customer PII copied from another Shopify store.

For `quality_edge_cases`, the importer only creates API-representable conditions such as blank SKUs, duplicate SKUs, zero-priced products, custom line items, mixed currencies where accepted by order import, guest orders and negative inventory where the target store permits it. Impossible anomalies belong in repository-level derivation fixtures, not in a Shopify store.

Bundle model: synthetic bundle products are treated as independently stocked SKUs. Component inventory is not silently decremented.
