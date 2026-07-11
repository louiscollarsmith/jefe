# MVP Plan

## MVP shape

The MVP is read-heavy and write-light.

It should earn trust before asking for dangerous permissions.

## Read-value layer

### 1. Daily Verdict

Inputs:
- Shopify orders
- refunds
- products
- variants
- inventory
- COGS
- shipping estimates
- Meta/Google spend read-only later

Outputs:
- true contribution margin by SKU/channel
- top winners
- top losers
- margin leaks
- missing data warnings
- simple conclusion

Example:
“You made £4.1k this week. SKU-12 appears to lose money after shipping. Here is why.”

### 2. Inventory Guardian

Inputs:
- current inventory
- sales velocity
- lead time if available
- margins
- seasonality later

Outputs:
- stockout date
- revenue/margin at risk
- reorder quantity
- supplier/PO draft

Example:
“Reorder 400 units of X by Tuesday or you will likely stock out on the 24th. Estimated £6.2k at risk.”

### 3. Watchdog

Inputs:
- sales trends
- refunds
- product changes
- discounts
- conversion data when available
- ad spend read-only later

Outputs:
- anomaly alerts
- silent breakage warnings
- suspicious changes

Example:
“Refunds on Product Y are 2.8x normal this week. Check sizing/quality issue.”

## One write loop

Klaviyo winback campaign:
- identify dormant customers
- create campaign draft
- randomised holdout
- merchant approval required
- staged send
- measure incremental revenue/margin
- report verified result

## MVP exit criteria

- 10 design partners live
- daily brief open rate >60%
- 5 converted to £299/month pilot
- holdout-verified lift in at least 3 stores
- zero cap-breach incidents
- time-to-first-verified-win <30 days
