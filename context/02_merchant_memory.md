# Merchant Memory

Merchant Memory is Jefe's structured understanding of a business.

It contains facts, beliefs, goals, constraints, preferences, processes, action permissions, unknowns and evidence.

It is versioned, inspectable and correctable.

## One memory across conversations

Conversation messages are Jefe's canonical interaction history across the app,
Slack, email, Goals, Plan, explicit Memory editing and action chat. Search
episodes and structured conversation summaries are derived indexes: they may be
rebuilt, but they never become evidence or authority by themselves.

Every LLM consumer reads through the bounded `MerchantContextPacket` contract.
The packet composes current working messages, authoritative beliefs, relevant
episodes, the action ledger, open questions and live evidence. Reads require both
merchant and shop identity. Shop-scoped data never crosses shops; only beliefs
explicitly stored as merchant-wide may join a shop packet.

Current authoritative truth outranks earlier conversation. Historical-only
content is excluded from normal work and appears only when a merchant explicitly
asks what was discussed before, with its historical status intact.

## Passive learning

Merchant-authored turns may propose durable-memory candidates. Deterministic
application code—not the LLM—checks the registered key, type, scope, validity,
tenant, provenance, PII rules and authority before promotion. Assistant messages
and generated summaries can be searched but can never originate a belief.

Corrections keep their evidence and history while replacing current truth.
Ambiguous conflicts create an open question. Forgetting retracts the belief,
suppresses linked candidates and makes linked search documents historical-only;
rebuilds and deterministic derivations must not resurrect it. Only an explicit,
newer merchant restatement may reactivate a retracted belief.

## Action memory

Recommendations, previews, executions, writes, reversals and outcomes remain in
`ActionExecution` and `ActionExecutionWrite`. Retrieval may link those rows to
conversation messages, but action outcomes are not copied into semantic beliefs
unless an existing registered deterministic derivation produces one.
