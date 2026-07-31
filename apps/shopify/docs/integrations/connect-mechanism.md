# Connect mechanism — recommendation (2026-07-31)

Detection ("what tools does this merchant run") is being built. This is the recommendation for the
CONNECT half: once a tool is detected, how does Jefe actually connect to it to read + act? Matt
asked for the best-mechanism call.

## Recommendation: hybrid, gateway-primary

1. **Primary = a unified integration gateway with an MCP / tool-calling interface.** One connect
   flow + one contract covers the long tail; the vendor maintains per-tool OAuth, APIs, and
   breaking-change upkeep. The MCP interface is the decisive fit: each connected tool surfaces as
   callable tools for Jefe's LLM — exactly how Jefe already works (LLM picks the verb → typed
   reversible adapter). Candidate: **Alloy** (named in `docs/integrations-strategy.md` as the
   MCP-gateway primary); evaluate against **Merge** and **Paragon**.
2. **Direct OAuth only for the 1–2 tools Jefe ACTS on constantly — Klaviyo first.** Email is
   already a Jefe action surface, so depth there (richer data, tighter control, no per-call gateway
   fee) earns the bespoke build. Everything else rides the gateway until usage proves it deserves a
   direct integration.
3. **Non-negotiable guardrail:** every connected-tool ACTION still routes through our typed
   reversible adapter — idempotency, preview, approval gate, blast-radius cap, reversibility,
   merchant-as-principal. The gateway connects + reads + carries the call; it NEVER executes
   unmediated. This is precisely what lets us add tools fast *without* loosening the autonomy
   guardrails.

## Why not the extremes
- **Direct-OAuth everything:** N integrations to build + maintain (each tool's OAuth, tokens, rate
  limits, breaking changes). Too slow for the long tail; only worth it where we act constantly.
- **Gateway everything:** cedes depth, per-call economics, and data-flow control on the tools we
  lean on most (email), and gateways' *action* coverage is shallower than their *read* coverage.

## Merchant-completed by design (safety)
Connecting a third-party tool requires the MERCHANT to authenticate — Jefe cannot and must not enter
a merchant's third-party credentials. So a connect offer is inherently **propose-only /
merchant-completed**: Jefe surfaces "you use Klaviyo — connect it?" and the merchant does the auth.
It never runs at the autonomous tier. That's why the connect offer is modeled as a `connectOffer`
descriptor on the tool-stack read (`tool-stack-read.server.js`) + a surface CTA — NOT as a
store-mutating entry in the action-capability registry. Different contract; don't conflate them.

## Sequencing — pick the vendor AFTER detection is live
Detection is now unblocked. Let it run on real stores first → see which tools OUR merchants actually
have → then choose on evidence:
- **Coverage** of our merchants' real tool set (detection tells us this).
- **MCP / tool-calling support** (the architectural fit above).
- **DPA + data residency + token custody** — prefer "we hold the tokens" / EU residency, matching
  the own-key posture from the Quiver DPA.
- **Pricing** (per-connection / per-call).

Deciding blind now over-commits; a few weeks of detection data de-risks the choice — which is exactly
why deferring the mechanism (Matt's call) was right.

## Next steps
1. **[detection]** land the `business.tool_stack` belief + a caller (in flight) → verify seed
   signatures on the test store.
2. **[product]** once real detections show, run the 3-vendor eval (Alloy / Merge / Paragon) on the
   criteria above.
3. **[build]** gateway connect flow behind a flag + Klaviyo direct-OAuth as the first deep
   integration; every action through the typed adapter.
