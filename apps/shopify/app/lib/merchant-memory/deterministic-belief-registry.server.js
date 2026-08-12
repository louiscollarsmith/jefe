// @ts-check

export const DETERMINISTIC_BELIEF_REGISTRY = [
  {
    "key": "business.primary_currency",
    "category": "business",
    "valueType": "currency_code",
    "derivationVersion": "v1",
    "window": "current_stored_state",
    "calculation": "mode(order.currency, variant.currency, successful_refund.currency)",
    "minimumData": "At least 1 priced commerce record",
    "confidenceRule": "0.95 if one currency covers >=95% of priced records; lower on mixed currencies",
    "legacyConfidenceRule": "0.95 if one currency covers >=95% of priced records; lower on mixed currencies",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 if one currency covers >=95% of priced records; lower on mixed currencies"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use successful refund transactions, not refund existence alone.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.store_name",
    "category": "business",
    "valueType": "string",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "shop.raw_payload.name, else shop.raw_payload.shop.name, else merchant.name",
    "minimumData": "Installed Shopify shop",
    "confidenceRule": "0.95 when Shopify shop name present; 0.70 on tenant/domain fallback",
    "legacyConfidenceRule": "0.95 when Shopify shop name present; 0.70 on tenant/domain fallback",
    "confidenceTemplate": "source_fallback_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "source_order": [
        "shopify_shop_name",
        "shopify_shop_payload_secondary_name",
        "merchant_tenant_name",
        "shop_domain"
      ],
      "legacy_rule": "0.95 when Shopify shop name present; 0.70 on tenant/domain fallback"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "fallback_source"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Avoid treating myshopify domain as a proper brand name.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "catalog.active_product_count",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(products where status = ACTIVE)",
    "minimumData": "Products imported",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/products/analytics"
  },
  {
    "key": "catalog.average_product_price",
    "category": "catalog",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "mean(current variant price across priced active variants, by shop currency)",
    "minimumData": "At least 1 priced active variant",
    "confidenceRule": "0.90; lower when currencies differ or price coverage is incomplete",
    "legacyConfidenceRule": "0.90; lower when currencies differ or price coverage is incomplete",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90; lower when currencies differ or price coverage is incomplete"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "This is list price, not realized selling price.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.has_product_variants",
    "category": "catalog",
    "valueType": "boolean",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "exists(product where count(active variants for product) > 1)",
    "minimumData": "Products and variants linked",
    "confidenceRule": "0.95 direct product-level test",
    "legacyConfidenceRule": "0.95 direct product-level test",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct product-level test"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Prefer product-level test over total_variant_count > product_count.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.out_of_stock_product_count",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active products where every inventory-tracked known variant has summed available <= 0)",
    "minimumData": "Active products with linked inventory",
    "confidenceRule": "0.85; lower when inventory coverage is incomplete",
    "legacyConfidenceRule": "0.85; lower when inventory coverage is incomplete",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.85; lower when inventory coverage is incomplete"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Track unknown-inventory products separately.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "catalog.total_product_count",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(non_deleted_products)",
    "minimumData": "Products imported",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/products/analytics"
  },
  {
    "key": "catalog.total_variant_count",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(non_deleted_variants)",
    "minimumData": "Variants imported",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "customers.known_customer_count",
    "category": "customers",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(distinct hashed_customer_identity with >=1 linked order)",
    "minimumData": "Customer identities imported and linked",
    "confidenceRule": "0.90; lower when guest orders are common or linkage is incomplete",
    "legacyConfidenceRule": "0.90; lower when guest orders are common or linkage is incomplete",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.90; lower when guest orders are common or linkage is incomplete"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not include PII in the belief.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Customer"
  },
  {
    "key": "customers.repeat_customer_rate.all_time",
    "category": "customers",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(customers with >=2 observed orders) / count(customers with >=1 observed order)",
    "minimumData": "At least 10 known customers",
    "confidenceRule": "0.85; rises with sample size and complete history",
    "legacyConfidenceRule": "0.85; rises with sample size and complete history",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85; rises with sample size and complete history"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 10
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      },
      {
        "template": "historical_coverage_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample",
      "partial_history"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Prefer observed linked orders over a possibly wider Shopify lifetime order_count unless histories align.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/customers-reports"
  },
  {
    "key": "customers.repeat_revenue_share.all_time",
    "category": "customers",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "sum(totalSpend of customers with >=2 orders) / sum(totalSpend of all known customers), shop base currency",
    "minimumData": "At least 10 known customers with recorded spend",
    "confidenceRule": "0.85 direct observation; rises with sample size",
    "legacyConfidenceRule": "0.85 direct observation; rises with sample size",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation; rises with sample size"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample", "incomplete_source_coverage"],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": ["orders", "customer_identities"],
    "tranche": "Customer memory v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not include PII in the belief; share of revenue from repeat customers, distinct from repeat customer rate (share of customers).",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/customers-reports"
  },
  {
    "key": "customers.average_lifetime_spend.all_time",
    "category": "customers",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "mean(totalSpend) across known customers, split by repeat (>=2 orders) vs one-time, shop base currency",
    "minimumData": "At least 10 known customers with recorded spend",
    "confidenceRule": "0.85 direct observation; rises with sample size",
    "legacyConfidenceRule": "0.85 direct observation; rises with sample size",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation; rises with sample size"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample", "incomplete_source_coverage"],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": ["orders", "customer_identities"],
    "tranche": "Customer memory v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not include PII in the belief; lifetime-value proxy over stored history, not a cohort-adjusted LTV.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/customers-reports"
  },
  {
    "key": "customers.top_customer_revenue_share.all_time",
    "category": "customers",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "sum(totalSpend of top 10 customers) / sum(totalSpend of all known customers), shop base currency",
    "minimumData": "At least 10 known customers with recorded spend",
    "confidenceRule": "0.85 direct observation; rises with sample size",
    "legacyConfidenceRule": "0.85 direct observation; rises with sample size",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation; rises with sample size"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample", "incomplete_source_coverage"],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": ["orders", "customer_identities"],
    "tranche": "Customer memory v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not include PII in the belief; revenue concentration across the top customers (concentration-risk signal).",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/customers-reports"
  },
  {
    "key": "inventory.out_of_stock_variant_count",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(inventory-tracked active variants where sum(available across active locations) <= 0)",
    "minimumData": "Variants linked to inventory",
    "confidenceRule": "0.85; lower with incomplete location coverage",
    "legacyConfidenceRule": "0.85; lower with incomplete location coverage",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.85; lower with incomplete location coverage"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Separate zero, negative, and unknown inventory states.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.total_tracked_units",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "sum(max(available, 0) across active inventory levels)",
    "minimumData": "Inventory levels imported",
    "confidenceRule": "0.85; lower if untracked variants are common",
    "legacyConfidenceRule": "0.85; lower if untracked variants are common",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.85; lower if untracked variants are common"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Also store negative inventory separately rather than allowing it to cancel positive stock.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel"
  },
  {
    "key": "orders.average_items_per_order.all_time",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "sum(line_item.quantity) / count(valid orders)",
    "minimumData": "At least 1 order and linked line items",
    "confidenceRule": "0.85; lower when line-item coverage is incomplete",
    "legacyConfidenceRule": "0.85; lower when line-item coverage is incomplete",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85; lower when line-item coverage is incomplete"
    },
    "confidenceComponents": [
      {
        "template": "historical_coverage_v1",
        "params": {}
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "label_as_all_stored_history_unless_full_history_is_verified",
    "dataQualityFlags": [
      "partial_history"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.average_order_value.all_time",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "sum(order_total_price) / count(priced valid orders)",
    "minimumData": "At least 1 priced order",
    "confidenceRule": "0.90 with single currency and complete priced-order coverage",
    "legacyConfidenceRule": "0.90 with single currency and complete priced-order coverage",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90 with single currency and complete priced-order coverage"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "historical_coverage_v1",
        "params": {}
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 1
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample",
      "partial_history"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Name should state whether tax, shipping, discounts, edits and refunds are included.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.first_order_at",
    "category": "orders",
    "valueType": "timestamp",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "min(order.processed_at else order.created_at)",
    "minimumData": "At least 1 order",
    "confidenceRule": "0.90; 0.95 only with complete order history",
    "legacyConfidenceRule": "0.90; 0.95 only with complete order history",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90; 0.95 only with complete order history"
    },
    "confidenceComponents": [
      {
        "template": "historical_coverage_v1",
        "params": {}
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "label_as_all_stored_history_unless_full_history_is_verified",
    "dataQualityFlags": [
      "partial_history"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "This is earliest stored order unless all-order access is confirmed.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "orders.latest_order_at",
    "category": "orders",
    "valueType": "timestamp",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "max(order.processed_at else order.created_at)",
    "minimumData": "At least 1 order",
    "confidenceRule": "0.95 direct timestamp",
    "legacyConfidenceRule": "0.95 direct timestamp",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 direct timestamp"
    },
    "confidenceComponents": [
      {
        "template": "historical_coverage_v1",
        "params": {}
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "label_as_all_stored_history_unless_full_history_is_verified",
    "dataQualityFlags": [
      "partial_history"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "orders.total_order_count",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(valid non-test stored orders)",
    "minimumData": "Orders imported",
    "confidenceRule": "0.90; 0.95 only if all-order scope and backfill completeness are confirmed",
    "legacyConfidenceRule": "0.90; 0.95 only if all-order scope and backfill completeness are confirmed",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90; 0.95 only if all-order scope and backfill completeness are confirmed"
    },
    "confidenceComponents": [
      {
        "template": "historical_coverage_v1",
        "params": {}
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "label_as_all_stored_history_unless_full_history_is_verified",
    "dataQualityFlags": [
      "partial_history"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not call all_time unless history completeness is confirmed.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "refunds.refunded_order_rate.all_time",
    "category": "refunds",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(distinct valid orders with >=1 refund record) / count(valid orders)",
    "minimumData": "At least 20 orders",
    "confidenceRule": "0.85; higher with complete refund import",
    "legacyConfidenceRule": "0.85; higher with complete refund import",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85; higher with complete refund import"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 20
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      },
      {
        "template": "historical_coverage_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample",
      "partial_history"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "This measures refund incidence, not returned item incidence.",
    "sourceUrl": "https://help.shopify.com/en/manual/fulfillment/managing-orders/returns"
  },
  {
    "key": "refunds.total_refunded_amount.all_time",
    "category": "refunds",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "sum(successful refund transaction amounts in shop currency)",
    "minimumData": "Refund transactions with status",
    "confidenceRule": "0.90 when successful transaction coverage is complete",
    "legacyConfidenceRule": "0.90 when successful transaction coverage is complete",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90 when successful transaction coverage is complete"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 5
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "historical_coverage_v1",
        "params": {}
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 5
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample",
      "partial_history"
    ],
    "refreshCadence": "Backfill + relevant webhooks",
    "dependencies": [
      "products",
      "variants",
      "orders",
      "line_items",
      "inventory_levels",
      "refunds",
      "customer_identities"
    ],
    "tranche": "0A \u2014 validate existing 19",
    "registryStatus": "Existing",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "A Refund record alone does not prove money moved; do not sum a nullable top-level amount.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Refund"
  },
  {
    "key": "inventory.at_risk_stockout_count.trailing_30d",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "count(selling products where available_units / (units_sold_30d / 30) < 21 days), tracked variants only",
    "minimumData": "At least 5 priced orders in the window and one product with recent sales and tracked inventory",
    "confidenceRule": "0.85 direct observation; rises with the number of evaluated products",
    "legacyConfidenceRule": "0.85 direct observation; rises with the number of evaluated products",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation; rises with the number of evaluated products"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample", "incomplete_inventory_coverage"],
    "refreshCadence": "On order or inventory change; debounce",
    "dependencies": ["orders", "line_items", "variants", "inventory_levels", "products"],
    "tranche": "Inventory velocity v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Missing inventory is unknown, never zero; slow sellers (fewer than 3 units in the window) are excluded to avoid noisy velocity.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.low_cover_products.trailing_30d",
    "category": "inventory",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "selling products with days-of-cover < 21, ranked ascending; days of cover = available_units / (units_sold_30d / 30)",
    "minimumData": "At least 5 priced orders in the window and one at-risk product with tracked inventory",
    "confidenceRule": "0.85 direct observation; rises with the number of evaluated products",
    "legacyConfidenceRule": "0.85 direct observation; rises with the number of evaluated products",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation; rises with the number of evaluated products"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample", "incomplete_inventory_coverage"],
    "refreshCadence": "On order or inventory change; debounce",
    "dependencies": ["orders", "line_items", "variants", "inventory_levels", "products"],
    "tranche": "Inventory velocity v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "The actionable reorder list; missing inventory is unknown, never zero; excludes slow sellers.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "data.currency_consistency",
    "category": "data",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "distribution of currencies across valid orders, variants and successful refunds; report dominant share and conflicts",
    "minimumData": "At least 1 priced record",
    "confidenceRule": "0.99 direct distribution",
    "legacyConfidenceRule": "0.99 direct distribution",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct distribution"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "orders",
      "variants",
      "refund_transactions"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not sum currencies without conversion.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "data.customer_identity_order_coverage",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(valid orders linked to a hashed customer identity) / count(valid orders)",
    "minimumData": "At least 1 order",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "orders",
      "customer_identities"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Low coverage should suppress or lower confidence in customer beliefs.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Customer"
  },
  {
    "key": "data.duplicate_sku_count",
    "category": "data",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(distinct nonblank SKU values assigned to >1 active variant)",
    "minimumData": "Active variants with SKU",
    "confidenceRule": "0.99 direct integrity metric",
    "legacyConfidenceRule": "0.99 direct integrity metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct integrity metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "variants"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Shared SKUs may be intentional in some setups; return examples in evidence.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "data.inventory_freshness_hours_p90",
    "category": "data",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "p90(as_of - inventory_level.updated_at)",
    "minimumData": "At least 5 inventory levels with updated_at",
    "confidenceRule": "0.95 direct freshness metric",
    "legacyConfidenceRule": "0.95 direct freshness metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.95 direct freshness metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "inventory_levels"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use merchant/shop timezone only for display; calculation remains UTC.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel"
  },
  {
    "key": "data.inventory_variant_coverage",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active inventory-tracked variants with >=1 active inventory level) / count(active inventory-tracked variants)",
    "minimumData": "At least 1 tracked variant",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Untracked inventory is not missing inventory.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel"
  },
  {
    "key": "data.line_item_product_link_coverage",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(line items linked to a stored product) / count(line items)",
    "minimumData": "At least 1 line item",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "line_items",
      "products"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Deleted products can legitimately reduce historical linkage.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/order-reports"
  },
  {
    "key": "data.line_item_variant_link_coverage",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(line items linked to a stored variant) / count(line items)",
    "minimumData": "At least 1 line item",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "line_items",
      "variants"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Historical or custom line items may have no variant.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/order-reports"
  },
  {
    "key": "data.missing_sku_variant_share",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active variants with blank/null SKU) / count(active variants)",
    "minimumData": "Active variants",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "variants"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Requires SKU field to be persisted from the standard variant payload.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "data.nonpositive_order_value_count",
    "category": "data",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(valid orders where total_price <= 0)",
    "minimumData": "Orders with prices",
    "confidenceRule": "0.99 direct anomaly count",
    "legacyConfidenceRule": "0.99 direct anomaly count",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct anomaly count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "orders"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not automatically delete; classify reasons where fields allow.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/finances-report"
  },
  {
    "key": "data.nonpositive_variant_price_count",
    "category": "data",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active variants where price <= 0)",
    "minimumData": "Active variants with prices",
    "confidenceRule": "0.99 direct anomaly count",
    "legacyConfidenceRule": "0.99 direct anomaly count",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct anomaly count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "variants"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Zero price can be intentional.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "data.order_history_completeness",
    "category": "data",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "combine read_all_orders scope, completed backfill cursor/state, earliest fetched order, and any Shopify count reconciliation",
    "minimumData": "Backfill metadata and granted scopes",
    "confidenceRule": "0.99 if scope + complete cursor + reconciliation all pass; otherwise explicit unknown",
    "legacyConfidenceRule": "0.99 if scope + complete cursor + reconciliation all pass; otherwise explicit unknown",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 if scope + complete cursor + reconciliation all pass; otherwise explicit unknown"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "shop_install",
      "backfill_runs",
      "orders"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Shopify Order access defaults to recent history unless all-order access is granted.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "data.order_history_span_days",
    "category": "data",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "date_diff(max(order_time), min(order_time)) + 1",
    "minimumData": "At least 2 orders on distinct dates",
    "confidenceRule": "0.99 direct observed span",
    "legacyConfidenceRule": "0.99 direct observed span",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct observed span"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "orders"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Observed span is not proof of full history.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "data.order_timestamp_coverage",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(valid orders with processed_at or created_at) / count(valid orders)",
    "minimumData": "At least 1 order",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "orders"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use one documented timestamp precedence consistently.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "data.orphan_inventory_level_count",
    "category": "data",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_stored_state",
    "calculation": "count(inventory levels whose inventory item/variant cannot be resolved)",
    "minimumData": "Inventory levels imported",
    "confidenceRule": "0.99 direct integrity check",
    "legacyConfidenceRule": "0.99 direct integrity check",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct integrity check"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Should normally be zero.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel"
  },
  {
    "key": "data.orphan_line_item_count",
    "category": "data",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_stored_state",
    "calculation": "count(line items whose order_id is absent)",
    "minimumData": "Line items imported",
    "confidenceRule": "0.99 direct integrity check",
    "legacyConfidenceRule": "0.99 direct integrity check",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct integrity check"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "orders",
      "line_items"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Should normally be zero.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/order-reports"
  },
  {
    "key": "data.priced_order_coverage",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(valid orders with usable total price and currency) / count(valid orders)",
    "minimumData": "At least 1 order",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "orders"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use this as an input to confidence for every order-value belief.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "data.priced_variant_coverage",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active variants with valid nonnegative price and currency) / count(active variants)",
    "minimumData": "At least 1 active variant",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "variants"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Separate zero-priced from missing-priced variants.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "data.refund_line_item_coverage",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(refunds with refund line items) / count(refunds)",
    "minimumData": "At least 1 refund",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "refunds",
      "refund_line_items"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Refunds can include shipping or goodwill refunds without line items.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/RefundLineItem"
  },
  {
    "key": "data.refund_transaction_amount_coverage",
    "category": "data",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(refunds with >=1 successful refund transaction amount) / count(refunds)",
    "minimumData": "At least 1 refund",
    "confidenceRule": "0.99 direct coverage metric",
    "legacyConfidenceRule": "0.99 direct coverage metric",
    "confidenceTemplate": "anomaly_integrity_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_full_population_scan": true,
      "legacy_rule": "0.99 direct coverage metric"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_as_internal_diagnostic",
    "dataQualityFlags": [
      "partial_scan"
    ],
    "refreshCadence": "Backfill + nightly validation",
    "dependencies": [
      "refunds",
      "refund_transactions"
    ],
    "tranche": "0B \u2014 data-quality guardrails",
    "registryStatus": "New candidate",
    "llmExposure": "Internal guardrail; use to set confidence",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Your current dump has 9 refund records but a total refunded amount of 0, so this should be implemented before more refund analytics.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Refund"
  },
  {
    "key": "business.active_selling_days.trailing_30d",
    "category": "business",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "count(distinct calendar dates with >=1 valid order)",
    "minimumData": "30 observed calendar days or store age",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use shop timezone for day boundaries.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.active_selling_days.trailing_90d",
    "category": "business",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "count(distinct calendar dates with >=1 valid order)",
    "minimumData": "90 observed calendar days or store age",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use shop timezone for day boundaries.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.order_value_bands.trailing_90d",
    "tranche": "Business shape v1",
    "category": "business",
    "valueType": "enum",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "quartiles of order value in shop base currency; shape from p75/p25 spread and mean/median skew",
    "minimumData": "At least 20 priced orders with a positive value",
    "confidenceRule": "0.85 scaled by sample size",
    "legacyConfidenceRule": "0.85 scaled by sample size",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "merchantVisible": false
  },
  {
    "key": "business.delivery_footprint.trailing_90d",
    "tranche": "Business shape v1",
    "category": "business",
    "valueType": "enum",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "share of orders per destination country; shape from primary-market share and country count",
    "minimumData": "At least 10 orders in the window with a destination country on >=70% of them",
    "confidenceRule": "0.85 scaled by destination coverage",
    "legacyConfidenceRule": "0.85 scaled by destination coverage",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "merchantVisible": false
  },
  {
    "key": "business.purchase_consideration.trailing_90d",
    "tranche": "Business shape v1",
    "category": "business",
    "valueType": "enum",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "median basket size, median order value against median catalogue price, and repeat share; both signals must agree or falls to mixed",
    "minimumData": "At least 20 priced orders, 3 priced active variants and 10 orders with line items",
    "confidenceRule": "0.75 scaled by sample size",
    "legacyConfidenceRule": "0.75 scaled by sample size",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "merchantVisible": false
  },
  {
    "key": "business.range_composition",
    "tranche": "Business shape v1",
    "category": "business",
    "valueType": "enum",
    "derivationVersion": "v1",
    "window": "current_stored_state",
    "calculation": "concentration of active products across productType and vendor; own-brand from vendor share, focus from leading category share",
    "minimumData": "At least 5 active products with a type or vendor on >=70% of them",
    "confidenceRule": "0.80 scaled by the better of type/vendor coverage",
    "legacyConfidenceRule": "0.80 scaled by the better of type/vendor coverage",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "merchantVisible": false
  },
  {
    "key": "business.channel_mix.trailing_90d",
    "tranche": "Business shape v1",
    "category": "business",
    "valueType": "enum",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "share of orders per classifySalesChannel bucket (online/pos/draft) over 90 days; bucketed into a shape",
    "minimumData": "At least 10 orders in the window with a sales channel recorded, covering >=70% of them",
    "confidenceRule": "0.85 scaled by channel coverage",
    "legacyConfidenceRule": "0.85 scaled by channel coverage",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "merchantVisible": false
  },
  {
    "key": "business.catalogue_shape",
    "tranche": "Business shape v1",
    "category": "business",
    "valueType": "enum",
    "derivationVersion": "v1",
    "window": "current_stored_state",
    "calculation": "active product count bucketed (1 / <=20 / <=200 / >200), with variants-per-product",
    "minimumData": "At least 1 active product",
    "confidenceRule": "0.90 from stored counts",
    "legacyConfidenceRule": "0.90 from stored counts",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "merchantVisible": false
  },
  {
    "key": "business.purchase_cadence.all_stored_history",
    "tranche": "Business shape v1",
    "category": "business",
    "valueType": "enum",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "median days between consecutive orders from the same customer, bucketed; one_off when almost nobody reorders",
    "minimumData": "At least 20 customer-attributed orders",
    "confidenceRule": "0.80 scaled by the number of observed repeat gaps",
    "legacyConfidenceRule": "0.80 scaled by the number of observed repeat gaps",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "merchantVisible": false
  },
  {
    "key": "business.activity_profile",
    "category": "business",
    "valueType": "enum",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "deterministic bucket from active_selling_day_share and orders_per_active_day: sparse, intermittent, steady, dense",
    "minimumData": "At least 30 observed days and 10 orders",
    "confidenceRule": "0.80; include threshold version in evidence",
    "legacyConfidenceRule": "0.80; include threshold version in evidence",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.80; include threshold version in evidence"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "This is an operational profile, not an industry label. Version thresholds.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.commerce_history_days",
    "category": "business",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "date_diff(max(order_time), min(order_time)) + 1",
    "minimumData": "At least 2 orders",
    "confidenceRule": "0.95 observed span; lower if history incomplete",
    "legacyConfidenceRule": "0.95 observed span; lower if history incomplete",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 observed span; lower if history incomplete"
    },
    "confidenceComponents": [
      {
        "template": "historical_coverage_v1",
        "params": {}
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "label_as_all_stored_history_unless_full_history_is_verified",
    "dataQualityFlags": [
      "partial_history"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Call this observed commerce history, not store age.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "business.currency_count.all_stored_history",
    "category": "business",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(distinct valid order currencies)",
    "minimumData": "At least 1 priced order",
    "confidenceRule": "0.99 direct count",
    "legacyConfidenceRule": "0.99 direct count",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.99 direct count"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "historical_coverage_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "partial_history"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Order count by currency is safer than aggregating money across currencies.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.days_since_last_order",
    "category": "business",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "date_diff(as_of, max(order_time))",
    "minimumData": "At least 1 order",
    "confidenceRule": "0.95 direct recency",
    "legacyConfidenceRule": "0.95 direct recency",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct recency"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Expected gaps vary by business model.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.multi_currency_order_share.trailing_90d",
    "category": "business",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "1 - count(orders in dominant currency) / count(priced orders)",
    "minimumData": "At least 10 priced orders",
    "confidenceRule": "0.95 direct distribution",
    "legacyConfidenceRule": "0.95 direct distribution",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 direct distribution"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 10
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not conflate with country mix.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.order_value_dispersion.trailing_90d",
    "category": "business",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "coefficient_of_variation(order_value) = stddev / mean",
    "minimumData": "At least 20 priced orders and mean > 0",
    "confidenceRule": "0.85",
    "legacyConfidenceRule": "0.85",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Winsorize or report outlier sensitivity separately.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.order_value_mean_to_median_ratio.trailing_90d",
    "category": "business",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "mean(order_value) / median(order_value)",
    "minimumData": "At least 20 priced orders",
    "confidenceRule": "0.85; rises with sample size",
    "legacyConfidenceRule": "0.85; rises with sample size",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85; rises with sample size"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 20
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "A high ratio is descriptive, not automatically problematic.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.orders_per_active_day.trailing_30d",
    "category": "business",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "order_count_30d / max(active_selling_days_30d,1)",
    "minimumData": "At least 5 orders",
    "confidenceRule": "0.90; rises with sample size",
    "legacyConfidenceRule": "0.90; rises with sample size",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.90; rises with sample size"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Pair with active-day share to avoid misleading sparse stores.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.revenue_per_active_day.trailing_30d",
    "category": "business",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "gross_order_value_30d / max(active_selling_days_30d,1)",
    "minimumData": "At least 5 priced orders",
    "confidenceRule": "0.90 with single currency and high price coverage",
    "legacyConfidenceRule": "0.90 with single currency and high price coverage",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90 with single currency and high price coverage"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 5
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Define order value inclusions explicitly.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.top_sales_day_revenue_share.trailing_90d",
    "category": "business",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "max(daily revenue) / sum(daily revenue)",
    "minimumData": "At least 10 active selling days",
    "confidenceRule": "0.85; rises with number of active days",
    "legacyConfidenceRule": "0.85; rises with number of active days",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85; rises with number of active days"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 10
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 10
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use shop timezone and exclude test orders.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.top_sales_week_revenue_share.trailing_180d",
    "category": "business",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_180d",
    "calculation": "max(calendar-week revenue) / sum(calendar-week revenue)",
    "minimumData": "At least 8 observed weeks",
    "confidenceRule": "0.85",
    "legacyConfidenceRule": "0.85",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 8
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 8
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample"
    ],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Calendar weeks should use shop locale/timezone.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.zero_sales_day_share.trailing_90d",
    "category": "business",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "count(calendar days with zero valid orders) / observed calendar days",
    "minimumData": "At least 30 observed days",
    "confidenceRule": "0.95 direct calendar metric",
    "legacyConfidenceRule": "0.95 direct calendar metric",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 direct calendar metric"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 30
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On order change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "New stores should use observed days since first order, not full 90 days.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "catalog.active_product_share",
    "category": "catalog",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "active_product_count / max(total_product_count,1)",
    "minimumData": "At least 1 product",
    "confidenceRule": "0.95 direct ratio",
    "legacyConfidenceRule": "0.95 direct ratio",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 direct ratio"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "products"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/products/analytics"
  },
  {
    "key": "catalog.archived_product_count",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(non_deleted products where status = ARCHIVED)",
    "minimumData": "Products imported",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "products"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Archived is not deleted.",
    "sourceUrl": "https://help.shopify.com/en/manual/products/analytics"
  },
  {
    "key": "catalog.draft_product_count",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(non_deleted products where status = DRAFT)",
    "minimumData": "Products imported",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "products"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Requires status values to be normalized.",
    "sourceUrl": "https://help.shopify.com/en/manual/products/analytics"
  },
  {
    "key": "catalog.max_variants_per_product",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "max(active variant count among active products)",
    "minimumData": "At least 1 active product",
    "confidenceRule": "0.95 direct max",
    "legacyConfidenceRule": "0.95 direct max",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct max"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "products",
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Include product reference in evidence, not in key.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.maximum_variant_price",
    "category": "catalog",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "max(price among priced active variants in primary currency)",
    "minimumData": "At least 1 priced active variant",
    "confidenceRule": "0.95 with single currency",
    "legacyConfidenceRule": "0.95 with single currency",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 with single currency"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Include referenced variant in evidence.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.median_variant_price",
    "category": "catalog",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "median(price among priced active variants in primary currency)",
    "minimumData": "At least 3 priced active variants",
    "confidenceRule": "0.95 with single currency",
    "legacyConfidenceRule": "0.95 with single currency",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 with single currency"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 3
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 3
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.minimum_variant_price",
    "category": "catalog",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "min(price among priced active variants in primary currency)",
    "minimumData": "At least 1 priced active variant",
    "confidenceRule": "0.95 with single currency",
    "legacyConfidenceRule": "0.95 with single currency",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 with single currency"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Exclude gift cards or zero-price variants only via explicit separate filters.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.multi_variant_product_count",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active products with >1 active variant)",
    "minimumData": "At least 1 active product",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "products",
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.multi_variant_product_share",
    "category": "catalog",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "multi_variant_product_count / active_product_count",
    "minimumData": "At least 1 active product",
    "confidenceRule": "0.95 direct ratio",
    "legacyConfidenceRule": "0.95 direct ratio",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 direct ratio"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "products",
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.single_variant_product_share",
    "category": "catalog",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active products with exactly 1 active variant) / active_product_count",
    "minimumData": "At least 1 active product",
    "confidenceRule": "0.95 direct ratio",
    "legacyConfidenceRule": "0.95 direct ratio",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 direct ratio"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "products",
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.variant_price_p25",
    "category": "catalog",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "p25(price among priced active variants)",
    "minimumData": "At least 8 priced active variants",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 8
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.variant_price_p75",
    "category": "catalog",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "p75(price among priced active variants)",
    "minimumData": "At least 8 priced active variants",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 8
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.variant_price_range_ratio",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "max(positive price) / min(positive price)",
    "minimumData": "At least 2 positive priced variants",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 2
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Can be dominated by an intentional outlier such as a gift card.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.variants_per_product_average",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "mean(active variant count per active product)",
    "minimumData": "At least 1 active product",
    "confidenceRule": "0.95 direct aggregate",
    "legacyConfidenceRule": "0.95 direct aggregate",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct aggregate"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "products",
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Count only variants linked to active products.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.variants_per_product_median",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "median(active variant count per active product)",
    "minimumData": "At least 3 active products",
    "confidenceRule": "0.95 direct aggregate",
    "legacyConfidenceRule": "0.95 direct aggregate",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95 direct aggregate"
    },
    "confidenceComponents": [
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 3
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_sample_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "products",
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.zero_price_variant_count",
    "category": "catalog",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active variants with price = 0)",
    "minimumData": "Active variants with price",
    "confidenceRule": "0.99 direct count",
    "legacyConfidenceRule": "0.99 direct count",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.99 direct count"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 5
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not assume zero price is an error.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "catalog.zero_price_variant_share",
    "category": "catalog",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "zero_price_variant_count / active_variant_count",
    "minimumData": "At least 1 active variant",
    "confidenceRule": "0.99 direct ratio",
    "legacyConfidenceRule": "0.99 direct ratio",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.99 direct ratio"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On product/variant change; debounce",
    "dependencies": [
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant"
  },
  {
    "key": "inventory.available_units_p90_per_variant",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "p90(max(summed available per known active tracked variant,0))",
    "minimumData": "At least 10 known tracked variants",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.in_stock_variant_count",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active inventory-tracked variants where summed available across active locations > 0)",
    "minimumData": "Tracked variants with inventory levels",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.in_stock_variant_share",
    "category": "inventory",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "in_stock_variant_count / active inventory-tracked variants with known inventory",
    "minimumData": "At least 1 known tracked variant",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Report unknown coverage separately.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.median_available_units_per_variant",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "median(max(summed available per known active tracked variant,0))",
    "minimumData": "At least 5 known tracked variants",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.negative_inventory_unit_magnitude",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "sum(abs(min(summed available per variant,0)))",
    "minimumData": "Known tracked variants",
    "confidenceRule": "0.95",
    "legacyConfidenceRule": "0.95",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.95"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Do not net negative units against positive units.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.negative_inventory_variant_count",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active tracked variants where summed available < 0)",
    "minimumData": "Known tracked variants",
    "confidenceRule": "0.95",
    "legacyConfidenceRule": "0.95",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.95"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Negative stock may be intentional when continuing to sell.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.negative_inventory_variant_share",
    "category": "inventory",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "negative_inventory_variant_count / known tracked variants",
    "minimumData": "At least 1 known tracked variant",
    "confidenceRule": "0.95",
    "legacyConfidenceRule": "0.95",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.95"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.positive_available_units",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "sum(max(summed available per active tracked variant,0))",
    "minimumData": "Known tracked variants",
    "confidenceRule": "0.95",
    "legacyConfidenceRule": "0.95",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.95"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "More interpretable than raw sum if negative quantities exist.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.retail_value_of_available_stock",
    "category": "inventory",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "sum(max(available_by_variant,0) * current variant price) in primary currency",
    "minimumData": "At least 1 priced known tracked variant and single currency",
    "confidenceRule": "0.85",
    "legacyConfidenceRule": "0.85",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 1
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "This is not cost value or expected revenue; discounts and sell-through are ignored.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.stale_inventory_level_share",
    "category": "inventory",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "count(active inventory levels not updated within versioned freshness threshold) / active levels",
    "minimumData": "Inventory level updated_at",
    "confidenceRule": "0.85",
    "legacyConfidenceRule": "0.85",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 10
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "A quiet item may legitimately have an old updated_at; treat as data freshness, not inventory error.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/InventoryLevel"
  },
  {
    "key": "inventory.top_5_variant_retail_value_share",
    "category": "inventory",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "sum(top 5 variant available_units * price) / total available stock retail value",
    "minimumData": "At least 5 priced stocked variants",
    "confidenceRule": "0.85",
    "legacyConfidenceRule": "0.85",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 5
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Uses retail price, not cost.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "inventory.units_per_active_product",
    "category": "inventory",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "positive_available_units / max(active_product_count,1)",
    "minimumData": "At least 1 active product",
    "confidenceRule": "0.85",
    "legacyConfidenceRule": "0.85",
    "confidenceTemplate": "freshness_coverage_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "minimum_coverage": 0.7,
      "missing_inventory_semantics": "unknown_not_zero",
      "legacy_rule": "0.85"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "suppress_if_stale_or_coverage_below_threshold",
    "dataQualityFlags": [
      "incomplete_inventory_coverage",
      "stale"
    ],
    "refreshCadence": "Inventory webhooks for simple state; daily for velocity; weekly for heavy",
    "dependencies": [
      "products",
      "variants",
      "inventory_levels"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Can hide uneven allocation; pair with median and concentration.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/inventory-reports"
  },
  {
    "key": "orders.average_items_per_order.trailing_30d",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "sum(line item quantities in valid orders) / valid order count in trailing 30 days",
    "minimumData": "At least 5 orders and high line-item coverage",
    "confidenceRule": "0.85; rises with sample and coverage",
    "legacyConfidenceRule": "0.85; rises with sample and coverage",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85; rises with sample and coverage"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders",
      "line_items"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Count quantities, not line-item rows.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.average_items_per_order.trailing_90d",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "sum(line item quantities in valid orders) / valid order count in trailing 90 days",
    "minimumData": "At least 5 orders and high line-item coverage",
    "confidenceRule": "0.85; rises with sample and coverage",
    "legacyConfidenceRule": "0.85; rises with sample and coverage",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85; rises with sample and coverage"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders",
      "line_items"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Count quantities, not line-item rows.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.average_order_value.trailing_30d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "gross_order_value_30d / priced_order_count_30d",
    "minimumData": "At least 5 priced orders",
    "confidenceRule": "0.80 at 5 orders; 0.90 at 20; 0.95 at 100+",
    "legacyConfidenceRule": "0.80 at 5 orders; 0.90 at 20; 0.95 at 100+",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.80 at 5 orders; 0.90 at 20; 0.95 at 100+"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 5
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "State inclusions and compare with median for skewed businesses.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.average_order_value.trailing_90d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "gross_order_value_90d / priced_order_count_90d",
    "minimumData": "At least 5 priced orders",
    "confidenceRule": "0.80 at 5 orders; 0.90 at 20; 0.95 at 100+",
    "legacyConfidenceRule": "0.80 at 5 orders; 0.90 at 20; 0.95 at 100+",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.80 at 5 orders; 0.90 at 20; 0.95 at 100+"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 5
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "State inclusions and compare with median for skewed businesses.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.average_unique_products_per_order.trailing_90d",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "mean(count(distinct product_id per valid order))",
    "minimumData": "At least 10 orders and high product-link coverage",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders",
      "line_items",
      "products"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Ignore custom line items or classify separately.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.average_unique_variants_per_order.trailing_90d",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "mean(count(distinct variant_id per valid order))",
    "minimumData": "At least 10 orders and high variant-link coverage",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders",
      "line_items",
      "variants"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.gross_order_value.trailing_30d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "sum(canonical gross order value for valid priced orders in trailing 30 days)",
    "minimumData": "At least 1 priced order",
    "confidenceRule": "0.90 with single currency and high price coverage",
    "legacyConfidenceRule": "0.90 with single currency and high price coverage",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90 with single currency and high price coverage"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 1
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Define canonical gross order value once; do not mix taxes/shipping policies across beliefs.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.gross_order_value.trailing_7d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_7d",
    "calculation": "sum(canonical gross order value for valid priced orders in trailing 7 days)",
    "minimumData": "At least 1 priced order",
    "confidenceRule": "0.90 with single currency and high price coverage",
    "legacyConfidenceRule": "0.90 with single currency and high price coverage",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90 with single currency and high price coverage"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 1
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Define canonical gross order value once; do not mix taxes/shipping policies across beliefs.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.gross_order_value.trailing_90d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "sum(canonical gross order value for valid priced orders in trailing 90 days)",
    "minimumData": "At least 1 priced order",
    "confidenceRule": "0.90 with single currency and high price coverage",
    "legacyConfidenceRule": "0.90 with single currency and high price coverage",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90 with single currency and high price coverage"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 1
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Define canonical gross order value once; do not mix taxes/shipping policies across beliefs.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.large_basket_order_share.trailing_90d",
    "category": "orders",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "count(valid orders with total item quantity >= 4) / valid orders",
    "minimumData": "At least 20 orders with line items",
    "confidenceRule": "0.85",
    "legacyConfidenceRule": "0.85",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 20
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders",
      "line_items"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Threshold is explicit and versioned, not industry-relative.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.longest_gap_between_orders.trailing_180d",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_180d",
    "calculation": "max(day difference between consecutive valid order timestamps)",
    "minimumData": "At least 5 orders in window",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use hours for high-volume stores only if useful.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.median_items_per_order.trailing_90d",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "median(sum quantities per order)",
    "minimumData": "At least 10 orders with line items",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 10
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_sample_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders",
      "line_items"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.median_order_value.trailing_30d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "median(canonical order value among valid priced orders in trailing 30 days)",
    "minimumData": "At least 5 priced orders",
    "confidenceRule": "0.85 at 5; 0.95 at 30+",
    "legacyConfidenceRule": "0.85 at 5; 0.95 at 30+",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85 at 5; 0.95 at 30+"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 5
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 5
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "More representative than mean when orders are lumpy.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.median_order_value.trailing_90d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "median(canonical order value among valid priced orders in trailing 90 days)",
    "minimumData": "At least 5 priced orders",
    "confidenceRule": "0.85 at 5; 0.95 at 30+",
    "legacyConfidenceRule": "0.85 at 5; 0.95 at 30+",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85 at 5; 0.95 at 30+"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 5
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      },
      {
        "template": "sample_size_v1",
        "params": {
          "suppress_below_sample": 5
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [
      "low_sample"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "More representative than mean when orders are lumpy.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.multi_item_order_share.trailing_90d",
    "category": "orders",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "count(valid orders with total item quantity >= 2) / valid orders",
    "minimumData": "At least 10 orders with line items",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 10
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders",
      "line_items"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.order_count.trailing_30d",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_30d",
    "calculation": "count(valid non-test orders with order_time in trailing 30 days)",
    "minimumData": "At least 1 observed day",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use shop timezone for window cutoffs; exclude test/cancelled according to canonical policy.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "orders.order_count.trailing_7d",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_7d",
    "calculation": "count(valid non-test orders with order_time in trailing 7 days)",
    "minimumData": "At least 1 observed day",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use shop timezone for window cutoffs; exclude test/cancelled according to canonical policy.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "orders.order_count.trailing_90d",
    "category": "orders",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "count(valid non-test orders with order_time in trailing 90 days)",
    "minimumData": "At least 1 observed day",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": [
      "incomplete_source_coverage"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Use shop timezone for window cutoffs; exclude test/cancelled according to canonical policy.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Order"
  },
  {
    "key": "orders.order_value_p25.trailing_90d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "p25(canonical order value)",
    "minimumData": "At least 20 priced orders",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 20
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.order_value_p75.trailing_90d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "p75(canonical order value)",
    "minimumData": "At least 20 priced orders",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 20
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.order_value_p90.trailing_90d",
    "category": "orders",
    "valueType": "currency_amount",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "p90(canonical order value)",
    "minimumData": "At least 20 priced orders",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "currency_coverage_v1",
        "params": {
          "minimum_priced_records": 20
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {
          "required_field": "priced_value"
        }
      }
    ],
    "confidencePublishPolicy": "suppress_if_mixed_currency_or_insufficient_sample",
    "dataQualityFlags": [],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.single_item_order_share.trailing_90d",
    "category": "orders",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "count(valid orders with total item quantity = 1) / valid orders",
    "minimumData": "At least 10 orders with line items",
    "confidenceRule": "0.90",
    "legacyConfidenceRule": "0.90",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.90"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 10
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders",
      "line_items"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Quantity = 1, not one line item.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "orders.zero_value_order_share.all_stored_history",
    "category": "orders",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "count(valid orders with canonical order value = 0) / valid orders",
    "minimumData": "At least 1 order",
    "confidenceRule": "0.99 direct ratio",
    "legacyConfidenceRule": "0.99 direct ratio",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.99 direct ratio"
    },
    "confidenceComponents": [
      {
        "template": "ratio_sample_coverage_v1",
        "params": {
          "suppress_below_denominator": 1
        }
      },
      {
        "template": "coverage_based_v1",
        "params": {}
      },
      {
        "template": "historical_coverage_v1",
        "params": {}
      }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": [
      "incomplete_source_coverage",
      "low_sample",
      "partial_history"
    ],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": [
      "orders"
    ],
    "tranche": "1A \u2014 cheap deterministic expansion",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Separate test, replacement and gift-card cases when fields allow.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/default-reports/finances-report"
  },
  {
    "key": "products.selling_product_count.trailing_90d",
    "category": "products",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "count(distinct product_id in line_items of priced orders within window)",
    "minimumData": "At least 5 priced orders in the window",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["incomplete_source_coverage"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Counts products with any sold line item on priced, non-test orders in the shop-local window.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.no_sale_active_product_count.trailing_90d",
    "category": "products",
    "valueType": "number",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "count(active_products whose product_id is not in sold_product_ids within window)",
    "minimumData": "At least 5 priced orders in the window and at least 1 active product",
    "confidenceRule": "0.95 direct count",
    "legacyConfidenceRule": "0.95 direct count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["incomplete_source_coverage"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Active products with zero sold line items in the window; a dead-stock signal, not a merchandising instruction.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.dead_stock.trailing_90d",
    "category": "products",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "active products in stock with no sales in window; trapped capital = units on hand × unit cost where cost is known",
    "minimumData": "At least 5 priced orders in the window and at least 1 in-stock, no-sale active product",
    "confidenceRule": "0.9 direct observation",
    "legacyConfidenceRule": "0.9 direct observation",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.9 direct observation"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["incomplete_source_coverage", "incomplete_inventory_coverage"],
    "refreshCadence": "On order or inventory change; debounce",
    "dependencies": ["orders", "line_items", "variants", "inventory_levels", "products"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Cash trapped in products that aren't moving; trapped capital is stated only where unit cost is known (never guessed). The memory fact behind the clearance action.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.top_product_revenue_share.trailing_90d",
    "category": "products",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "max(product_revenue) / sum(product_revenue) within window",
    "minimumData": "At least 5 priced orders, at least 2 products with sales, single order currency",
    "confidenceRule": "0.9 direct ratio; suppressed on insufficient coverage",
    "legacyConfidenceRule": "0.9 direct ratio; suppressed on insufficient coverage",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.9 direct ratio"
    },
    "confidenceComponents": [
      { "template": "ratio_sample_coverage_v1", "params": { "suppress_below_denominator": 1 } },
      { "template": "coverage_based_v1", "params": {} }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Revenue concentration of the single top product; requires a single order currency in the window.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.top_5_product_revenue_share.trailing_90d",
    "category": "products",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "sum(top 5 product_revenue) / sum(product_revenue) within window",
    "minimumData": "At least 5 priced orders, at least 2 products with sales, single order currency",
    "confidenceRule": "0.9 direct ratio; suppressed on insufficient coverage",
    "legacyConfidenceRule": "0.9 direct ratio; suppressed on insufficient coverage",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.9 direct ratio"
    },
    "confidenceComponents": [
      { "template": "ratio_sample_coverage_v1", "params": { "suppress_below_denominator": 1 } },
      { "template": "coverage_based_v1", "params": {} }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Revenue concentration of the top 5 products; requires a single order currency in the window.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.bestseller_by_revenue.trailing_90d",
    "category": "products",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "argmax_product(sum(line_total)) within window; value carries revenue and revenue share",
    "minimumData": "At least 5 priced orders, at least 1 product with sales, single order currency",
    "confidenceRule": "0.9 direct observation",
    "legacyConfidenceRule": "0.9 direct observation",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.9 direct observation"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Identifies the highest-revenue product and its revenue share; requires a single order currency in the window.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.bestseller_by_units.trailing_90d",
    "category": "products",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "argmax_product(sum(quantity)) within window; value carries units and unit share",
    "minimumData": "At least 5 priced orders and at least 1 product with sales",
    "confidenceRule": "0.9 direct observation",
    "legacyConfidenceRule": "0.9 direct observation",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.9 direct observation"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Identifies the highest-unit-volume product and its share of units in the window.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.cost_coverage",
    "category": "products",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "active_variants_with_unit_cost / active_variants",
    "minimumData": "At least 1 active variant",
    "confidenceRule": "0.95 direct ratio",
    "legacyConfidenceRule": "0.95 direct ratio",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.95 direct ratio"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["incomplete_source_coverage"],
    "refreshCadence": "On product change; debounce",
    "dependencies": ["products", "variants"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Share of active variants with a Shopify cost-per-item set; a readiness signal for margin, not a margin itself.",
    "sourceUrl": "https://help.shopify.com/en/manual/products/inventory/getting-started-with-inventory/cost-per-item"
  },
  {
    "key": "products.gross_margin.trailing_90d",
    "category": "products",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "(covered_revenue - covered_cogs) / covered_revenue over cost-covered line items in window",
    "minimumData": "At least 5 priced orders, single order currency, and cost-per-item covering >=70% of window revenue",
    "confidenceRule": "0.85; scaled by cost coverage and sample",
    "legacyConfidenceRule": "0.85; scaled by cost coverage and sample",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85 scaled by coverage"
    },
    "confidenceComponents": [
      { "template": "coverage_based_v1", "params": {} },
      { "template": "sample_size_v1", "params": { "suppress_below_sample": 5 } }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": ["low_sample", "incomplete_source_coverage"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products", "variants"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Gross margin over only the cost-covered share of revenue; value carries revenueCoverage. Excludes shipping and fees. Requires a single order currency.",
    "sourceUrl": "https://help.shopify.com/en/manual/products/inventory/getting-started-with-inventory/cost-per-item"
  },
  {
    "key": "business.online_revenue_share.trailing_90d",
    "category": "business",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "online_store_revenue / revenue_with_known_sales_channel within window",
    "minimumData": "At least 5 priced orders and a known sales channel on >=70% of window revenue",
    "confidenceRule": "0.9; scaled by channel coverage and sample",
    "legacyConfidenceRule": "0.9; scaled by channel coverage and sample",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.9 scaled by coverage"
    },
    "confidenceComponents": [
      { "template": "coverage_based_v1", "params": {} },
      { "template": "sample_size_v1", "params": { "suppress_below_sample": 5 } }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": ["incomplete_source_coverage"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Online-store vs in-store/other revenue split from Shopify order sourceName; value carries the per-channel breakdown. Coverage-gated — older orders lack sourceName until re-backfilled.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.revenue_by_region.trailing_90d",
    "category": "business",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "revenue grouped by destination country / revenue_with_known_country within window",
    "minimumData": "At least 5 priced orders and a known destination country on >=70% of window revenue",
    "confidenceRule": "0.9; scaled by country coverage and sample",
    "legacyConfidenceRule": "0.9; scaled by country coverage and sample",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.9 scaled by coverage"
    },
    "confidenceComponents": [
      { "template": "coverage_based_v1", "params": {} },
      { "template": "sample_size_v1", "params": { "suppress_below_sample": 5 } }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": ["incomplete_source_coverage"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Revenue split by destination country (from order shipping/billing country_code); value carries the top countries with shares. Coverage-gated — older orders lack a country until re-backfilled. The geo signal behind store-split and international-expansion decisions.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.margin_by_region.trailing_90d",
    "category": "business",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "per destination country: (covered revenue - covered COGS) / covered revenue, over the cost-covered share of the region's revenue",
    "minimumData": "At least 5 priced orders, a known country on >=70% of window revenue, and >=70% cost coverage in at least one region",
    "confidenceRule": "0.85; scaled by country + cost coverage",
    "legacyConfidenceRule": "0.85; scaled by country + cost coverage",
    "confidenceTemplate": "composite_min_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "combiner": "minimum",
      "legacy_rule": "0.85 scaled by coverage"
    },
    "confidenceComponents": [
      { "template": "coverage_based_v1", "params": {} },
      { "template": "sample_size_v1", "params": { "suppress_below_sample": 5 } }
    ],
    "confidencePublishPolicy": "suppress_if_denominator_or_coverage_is_insufficient",
    "dataQualityFlags": ["incomplete_source_coverage"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "variants"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Gross margin per destination country; a region's margin is stated only where cost-per-item covers >=70% of its revenue, never guessed. The profitability half of the store-split / expansion decision (revenue_by_region is the volume half).",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.discount_depth.trailing_90d",
    "category": "business",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "sum(total_discounts) / (sum(total_price) + sum(total_discounts)) within window; plus share of orders with any discount",
    "minimumData": "At least 5 priced orders in the window with positive revenue",
    "confidenceRule": "0.9 direct observation",
    "legacyConfidenceRule": "0.9 direct observation",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.9 direct observation"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["incomplete_source_coverage"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Share of pre-discount revenue given away in discounts, and the share of orders discounted; a margin-leak signal, not a directive.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.top_returned_products.trailing_180d",
    "category": "products",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_180d",
    "calculation": "products ranked by returned units from refund line items within window; carries return rate vs sold units",
    "minimumData": "At least 1 refund with line items mapped to products in the window",
    "confidenceRule": "0.85 direct observation",
    "legacyConfidenceRule": "0.85 direct observation",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["incomplete_source_coverage"],
    "refreshCadence": "On order/refund change; debounce",
    "dependencies": ["orders", "line_items", "refunds", "products"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Most-returned products by units, with per-product return rate (returned/sold). From backfilled refund line items; real-time webhook refunds (REST shape) + a normalized table are follow-ups.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.product_momentum.trailing_60d",
    "category": "products",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_60d",
    "calculation": "products with >=20% revenue change, current 30 days vs prior 30 days",
    "minimumData": "At least 5 priced orders in each of the current and prior 30-day windows",
    "confidenceRule": "0.8 direct observation",
    "legacyConfidenceRule": "0.8 direct observation",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.8 direct observation"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Rising/declining product counts + top riser/faller by revenue, current 30d vs prior 30d. Only judges products with prior-period revenue (excludes brand-new products).",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.yoy_revenue_growth.trailing_90d",
    "category": "business",
    "valueType": "percentage",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "(current_90d_revenue - same_90d_one_year_ago_revenue) / same_90d_one_year_ago_revenue",
    "minimumData": "At least 5 priced orders in both the current window and the same window one year ago (needs >12 months of history)",
    "confidenceRule": "0.85 direct observation",
    "legacyConfidenceRule": "0.85 direct observation",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Year-over-year revenue change, trailing 90 days vs the same 90 days a year ago; requires >12 months of stored history (unlocked by the extended backfill window).",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.revenue_trend.trailing_180d",
    "category": "business",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_180d",
    "calculation": "revenue in recent 90 days vs prior 90 days; growing/flat/declining at +/-10%",
    "minimumData": "At least 5 priced orders in each of the recent and prior 90-day windows",
    "confidenceRule": "0.85 direct observation",
    "legacyConfidenceRule": "0.85 direct observation",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders"],
    "tranche": "Product performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Sequential revenue trend (recent 90d vs prior 90d), growing/flat/declining at a +/-10% threshold; complements year-over-year.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.revenue_by_product_type.trailing_90d",
    "category": "products",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "sum(line-item revenue) grouped by product_type over the window; top types by revenue with share, shop base currency",
    "minimumData": "At least 5 priced orders in the window and one sold product with a product type",
    "confidenceRule": "0.85 direct observation; rises with order volume",
    "legacyConfidenceRule": "0.85 direct observation; rises with order volume",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation; rises with order volume"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample", "incomplete_source_coverage"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products"],
    "tranche": "Attribute performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Products without a product type are pooled as unattributed revenue, not dropped; product type is an optional Shopify field.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "products.revenue_by_vendor.trailing_90d",
    "category": "products",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "trailing_90d",
    "calculation": "sum(line-item revenue) grouped by vendor over the window; top vendors by revenue with share, shop base currency",
    "minimumData": "At least 5 priced orders in the window and one sold product with a vendor",
    "confidenceRule": "0.85 direct observation; rises with order volume",
    "legacyConfidenceRule": "0.85 direct observation; rises with order volume",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.85 direct observation; rises with order volume"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample", "incomplete_source_coverage"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders", "line_items", "products"],
    "tranche": "Attribute performance v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Products without a vendor are pooled as unattributed revenue, not dropped; vendor is an optional Shopify field.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.peak_sales_month.all_time",
    "category": "business",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "revenue aggregated by month-of-year across stored history (shop timezone); peak month + monthly breakdown, shop base currency",
    "minimumData": "At least 20 priced dated orders spanning about 12 months",
    "confidenceRule": "0.80 direct observation; rises with months of history",
    "legacyConfidenceRule": "0.80 direct observation; rises with months of history",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": true,
      "legacy_rule": "0.80 direct observation; rises with months of history"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample", "partial_history"],
    "refreshCadence": "On order change; debounce",
    "dependencies": ["orders"],
    "tranche": "Seasonality v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Needs about a year of history; months are bucketed in the shop timezone. Requires read_all_orders for history beyond 60 days.",
    "sourceUrl": "https://help.shopify.com/en/manual/reports-and-analytics/shopify-reports/report-types/analytics-fields"
  },
  {
    "key": "business.recommendation_engagement.all_time",
    "category": "business",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "counts of plan recommendation review outcomes (accepted/rejected/completed) with acceptance and completion rates",
    "minimumData": "At least 3 recommendations",
    "confidenceRule": "0.90 direct observation; rises with recommendation count",
    "legacyConfidenceRule": "0.90 direct observation; rises with recommendation count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": false,
      "legacy_rule": "0.90 direct observation; rises with recommendation count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On recommendation review; debounce",
    "dependencies": ["plan_recommendations"],
    "tranche": "Recommendation outcomes v1",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "An engagement signal for the earned-autonomy ramp, not a store metric; depends on the merchant reviewing recommendations in-app.",
    "sourceUrl": "https://shopify.dev/docs/apps/build/online-store"
  },
  {
    "key": "business.clearance_effectiveness.all_time",
    "category": "business",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "aggregate of measured clearance-run outcomes (variants cleared/sold, units moved, revenue recovered) with variant sell-through and per-run effectiveness rates",
    "minimumData": "At least 3 measured clearance runs",
    "confidenceRule": "0.90 direct observation; rises with measured-run count",
    "legacyConfidenceRule": "0.90 direct observation; rises with measured-run count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": false,
      "legacy_rule": "0.90 direct observation; rises with measured-run count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On clearance outcome measurement; debounce",
    "dependencies": ["action_executions"],
    "tranche": "Clearance outcomes v1",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "An earned-autonomy signal, not a store metric; dormant until clearance execution is live (no measured runs while the write flag is off).",
    "sourceUrl": "https://shopify.dev/docs/apps/build/online-store"
  },
  {
    "key": "business.action_decline_signal.all_time",
    "category": "business",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "all_stored_history",
    "calculation": "counts of declined actions grouped by reason category and action type, with the most common reason and its share",
    "minimumData": "At least 3 declined actions",
    "confidenceRule": "0.90 direct observation; rises with decline count",
    "legacyConfidenceRule": "0.90 direct observation; rises with decline count",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": false,
      "legacy_rule": "0.90 direct observation; rises with decline count"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["low_sample"],
    "refreshCadence": "On action decline; debounce",
    "dependencies": ["activity_events"],
    "tranche": "Action feedback v1",
    "registryStatus": "New candidate",
    "llmExposure": "On-demand; promote only when decision-relevant",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "A feedback signal for the earned-autonomy ramp; PII-safe (reason categories only). Dormant until actions are executable (declines flow once the write flag is on).",
    "sourceUrl": "https://shopify.dev/docs/apps/build/online-store"
  },
  {
    "key": "business.tool_stack",
    "category": "business",
    "valueType": "structured",
    "derivationVersion": "v1",
    "window": "current_state",
    "calculation": "detectToolStack(shopify signals) — match native Shopify signals (metafield namespaces, payment gateways, order/customer tags, fulfilment services) against the seed tool-signature registry; value = detected tools with per-tool confidence, value confidence = strongest single matched signal",
    "minimumData": "At least 1 third-party tool signature matched from observed Shopify signals",
    "confidenceRule": "max per-tool matched-signal confidence (metafield/gateway ~0.9, tag ~0.6); model inference, merchant-correctable",
    "legacyConfidenceRule": "max per-tool matched-signal confidence (metafield/gateway ~0.9, tag ~0.6); model inference, merchant-correctable",
    "confidenceTemplate": "direct_observation_v1",
    "confidenceTemplateVersion": "v1",
    "confidenceParameters": {
      "requires_completed_relevant_backfill": false,
      "legacy_rule": "max per-tool matched-signal confidence (metafield/gateway ~0.9, tag ~0.6); model inference, merchant-correctable"
    },
    "confidenceComponents": [],
    "confidencePublishPolicy": "publish_when_minimum_data_met",
    "dataQualityFlags": ["incomplete_source_coverage", "low_sample"],
    "refreshCadence": "Backfill + relevant webhooks; on tool-stack detection run",
    "dependencies": ["orders", "customer_identities"],
    "tranche": "Tool stack v1",
    "registryStatus": "New candidate",
    "llmExposure": "Core or category retrieval",
    "materializationRule": "Persist only when minimum data is met; otherwise record skipped/insufficient in refresh diagnostics.",
    "caveat": "Model inference from native Shopify signals — never a merchant-confirmed fact; supersedable by merchant correction. Every signature is SEED until verified against real stores (a wrong signature is a false detection). The strongest signals (metafield namespaces) arrive via the live-query feeder gated on ENABLE_TOOL_STACK_DETECTION; order-derived signals stay dormant until Order.rawPayload is selected in loadDerivationContext. PII-safe: tool ids/categories + signal kinds only, never customer data.",
    "sourceUrl": "https://shopify.dev/docs/api/admin-graphql/latest/objects/Shop"
  }
];

export const DETERMINISTIC_CONFIDENCE_TEMPLATE_REGISTRY = {
  "direct_observation_v1": {
    "purpose": "Direct counts, booleans, timestamps, and integrity checks from normalized source records.",
    "output_scores": [
      0.98,
      0.95,
      0.85,
      0.7
    ],
    "parameters": {
      "complete_score": 0.98,
      "high_coverage_score": 0.95,
      "partial_score": 0.85,
      "weak_score": 0.7,
      "high_coverage_threshold": 0.95,
      "partial_coverage_threshold": 0.8
    },
    "evaluation": [
      "Use complete_score when the relevant backfill is complete, source coverage is complete, and freshness requirements are met.",
      "Use high_coverage_score when source coverage meets high_coverage_threshold.",
      "Use partial_score when source coverage meets partial_coverage_threshold.",
      "Otherwise suppress or return insufficient_data unless the row explicitly permits weak directional publication."
    ]
  },
  "source_fallback_v1": {
    "purpose": "Beliefs selected from an ordered list of sources with different authority.",
    "output_scores": [
      0.98,
      0.9,
      0.7,
      0.5
    ],
    "parameters": {
      "source_scores": {
        "authoritative_platform_field": 0.98,
        "secondary_platform_field": 0.9,
        "merchant_tenant_metadata": 0.7,
        "domain_or_heuristic_fallback": 0.5
      }
    },
    "evaluation": [
      "Choose the score associated with the highest-authority populated source.",
      "Persist the selected source and rejected fallback sources in confidence provenance."
    ]
  },
  "coverage_based_v1": {
    "purpose": "Beliefs whose reliability is primarily determined by source-field coverage.",
    "output_scores": [
      0.95,
      0.9,
      0.8,
      0.65
    ],
    "parameters": {
      "bands": [
        {
          "minimum_coverage": 0.95,
          "score": 0.95
        },
        {
          "minimum_coverage": 0.85,
          "score": 0.9
        },
        {
          "minimum_coverage": 0.7,
          "score": 0.8
        },
        {
          "minimum_coverage": 0.5,
          "score": 0.65
        }
      ],
      "suppress_below_coverage": 0.5
    },
    "evaluation": [
      "Coverage is eligible source records with the required field divided by all eligible source records.",
      "Suppress below suppress_below_coverage unless the row explicitly allows a low-confidence diagnostic belief."
    ]
  },
  "sample_size_v1": {
    "purpose": "Averages, medians, percentiles, distributions, and other aggregates dominated by sample size.",
    "output_scores": [
      0.92,
      0.85,
      0.75,
      0.6
    ],
    "parameters": {
      "bands": [
        {
          "minimum_sample": 100,
          "score": 0.92
        },
        {
          "minimum_sample": 30,
          "score": 0.85
        },
        {
          "minimum_sample": 10,
          "score": 0.75
        },
        {
          "minimum_sample": 5,
          "score": 0.6
        }
      ],
      "suppress_below_sample": 5
    },
    "evaluation": [
      "Use the highest matching sample-size band.",
      "Combine with coverage, freshness, currency, and history components where relevant."
    ]
  },
  "ratio_sample_coverage_v1": {
    "purpose": "Rates, shares, and ratios that require both numerator/denominator integrity and adequate sample size.",
    "output_scores": [
      0.95,
      0.9,
      0.8,
      0.65
    ],
    "parameters": {
      "sample_bands": [
        {
          "minimum_denominator": 500,
          "score": 0.95
        },
        {
          "minimum_denominator": 100,
          "score": 0.9
        },
        {
          "minimum_denominator": 25,
          "score": 0.8
        },
        {
          "minimum_denominator": 10,
          "score": 0.65
        }
      ],
      "minimum_coverage": 0.8,
      "suppress_below_denominator": 10,
      "zero_denominator_result": "insufficient_data"
    },
    "evaluation": [
      "Calculate a sample score from the denominator.",
      "Calculate source coverage for both numerator and denominator populations.",
      "Final score is the minimum of sample score and coverage score."
    ]
  },
  "currency_coverage_v1": {
    "purpose": "Currency codes and currency aggregates where mixed currencies can invalidate comparison or aggregation.",
    "output_scores": [
      0.98,
      0.95,
      0.9,
      0.75
    ],
    "parameters": {
      "dominant_currency_bands": [
        {
          "minimum_share": 1.0,
          "score": 0.98
        },
        {
          "minimum_share": 0.98,
          "score": 0.95
        },
        {
          "minimum_share": 0.95,
          "score": 0.9
        },
        {
          "minimum_share": 0.8,
          "score": 0.75
        }
      ],
      "minimum_priced_records": 5,
      "suppress_below_dominant_share": 0.8,
      "mixed_currency_policy": "do_not_aggregate_without_normalisation"
    },
    "evaluation": [
      "Determine the dominant currency among eligible priced records.",
      "Use the dominant-currency share band and cap by sample-size and field-coverage components.",
      "Suppress currency aggregates when currencies are mixed below the permitted threshold and no FX normalisation is available."
    ]
  },
  "freshness_coverage_v1": {
    "purpose": "Inventory and operational current-state beliefs that become unreliable when source observations are stale.",
    "output_scores": [
      0.95,
      0.85,
      0.7,
      0.5
    ],
    "parameters": {
      "freshness_bands": [
        {
          "maximum_age_hours": 24,
          "score": 0.95
        },
        {
          "maximum_age_hours": 72,
          "score": 0.85
        },
        {
          "maximum_age_hours": 168,
          "score": 0.7
        },
        {
          "maximum_age_hours": 720,
          "score": 0.5
        }
      ],
      "minimum_coverage": 0.7,
      "suppress_when_older_than_hours": 720
    },
    "evaluation": [
      "Calculate both freshness and source coverage.",
      "Final score is the minimum of freshness and coverage component scores.",
      "Missing inventory is unknown, not zero."
    ]
  },
  "historical_coverage_v1": {
    "purpose": "First/last events and all-history aggregates where stored history may not equal merchant lifetime history.",
    "output_scores": [
      0.98,
      0.9,
      0.7,
      0.55
    ],
    "parameters": {
      "coverage_scores": {
        "verified_full_history": 0.98,
        "complete_declared_window": 0.9,
        "partial_history": 0.7,
        "unknown_history": 0.55
      },
      "all_time_label_requires_verified_full_history": true
    },
    "evaluation": [
      "Use verified_full_history only when access and backfill coverage prove lifetime completeness.",
      "Otherwise describe the window as all_stored_history or a bounded date range.",
      "Combine with sample and field coverage where relevant."
    ]
  },
  "time_series_v1": {
    "purpose": "Trends, seasonality, volatility, anomalies, and period-over-period comparisons.",
    "output_scores": [
      0.92,
      0.85,
      0.75,
      0.6
    ],
    "parameters": {
      "minimum_complete_periods": 3,
      "preferred_complete_periods": 8,
      "minimum_events_per_period": 5,
      "suppress_when_periods_below": 3,
      "requires_comparable_periods": true
    },
    "evaluation": [
      "Require complete and comparable periods.",
      "Score using the minimum of complete-period count, events per period, history coverage, and field coverage.",
      "Suppress seasonality claims without sufficient repeated seasonal periods."
    ]
  },
  "anomaly_integrity_v1": {
    "purpose": "Data-quality, anomaly, and integrity beliefs reporting directly measured defects or coverage.",
    "output_scores": [
      0.99,
      0.95,
      0.85
    ],
    "parameters": {
      "direct_integrity_score": 0.99,
      "high_coverage_score": 0.95,
      "partial_scan_score": 0.85
    },
    "evaluation": [
      "Confidence reflects whether the diagnostic scan covered the full eligible source population.",
      "The severity of an anomaly is separate from confidence that the anomaly count is correct."
    ]
  },
  "composite_min_v1": {
    "purpose": "Combines named confidence components conservatively.",
    "output_scores": "component-dependent",
    "parameters": {
      "combiner": "minimum",
      "round_to": 2,
      "suppress_if_any_required_component_is_insufficient": true
    },
    "evaluation": [
      "Evaluate each named component independently.",
      "The final score is the minimum component score.",
      "Persist all component scores, versions, inputs, and the limiting component."
    ]
  }
};

// Beliefs Jefe HOLDS and reasons with, but does not yet assert to the merchant's face.
//
// A belief that derives is a belief the memory view renders — `getMerchantMemoryView` lists
// everything active — so "let it run, don't show it yet" needs to be a real gate rather than
// an intention. Entries default to visible; only an explicit `merchantVisible: false` hides
// one. Founder call (2026-08-12): the business-shape tranche derives against real stores and
// is reviewed before any merchant is told what kind of business Jefe thinks they run.
//
// This hides a belief from the MEMORY SURFACE only. It is not a secret: the belief is stored
// with full provenance and evidence, and Jefe still reasons from it.
const MERCHANT_HIDDEN_BELIEF_KEYS = new Set(
  DETERMINISTIC_BELIEF_REGISTRY.filter((entry) => entry.merchantVisible === false).map(
    (entry) => entry.key,
  ),
);

/** @param {string} key */
export function isMerchantVisibleBeliefKey(key) {
  return !MERCHANT_HIDDEN_BELIEF_KEYS.has(key);
}

// The business-shape tranche: what KIND of business this is, rather than a fact about it.
//
// Derived from the tranche rather than a hand-kept list, so a new dimension is included the
// day it lands instead of the day someone remembers to add it here.
const BUSINESS_SHAPE_BELIEF_KEYS = new Set(
  DETERMINISTIC_BELIEF_REGISTRY.filter((entry) => entry.tranche === "Business shape v1").map(
    (entry) => entry.key,
  ),
);

/**
 * Shape beliefs FRAME an answer rather than being the subject of one. A merchant asking
 * about stock needs the stock numbers — but the answer should differ depending on whether
 * they are a one-product maker or a 5,000-SKU retailer, and that context is relevant to
 * every question, not just to questions that happen to mention it.
 * @param {string} key
 */
export function isBusinessShapeBeliefKey(key) {
  return BUSINESS_SHAPE_BELIEF_KEYS.has(key);
}
