# 02 — House Rules and Goals

## Why this exists

House Rules are core to the product identity.

They make Jefe feel like a manager that understands the merchant's business rather than a generic AI assistant.

They also directly address a major failure mode of native AI assistants: constraint violations.

## Onboarding capture

At onboarding, capture:

### Goals

- 3-month goal
- 6-month goal
- 12-month goal

Every brief should answer:

> What did I do about your goal, and what did it verifiably earn you?

### House Rules

The merchant writes a short constitution the manager must obey.

Capture structured rules for:
- maximum discount depth by SKU/product class
- email frequency limits by segment
- protected hero products
- margin-over-volume priorities
- seasonal priorities
- risky actions requiring extra approval
- products that should never be discounted
- brand voice constraints

Also capture free-text rules.

## Product behaviour

House Rules must feed:

1. Policy scorer
2. Caps engine
3. Action generator
4. Approval friction
5. UI explanations

Every action proposal should cite which rules were consulted.

Example:

> I did not propose deeper discounting because your House Rules cap Hero SKUs at 20%.

## Technical representation

Store on `merchants` or related table as:
- `goals_json`
- `house_rules`
- structured rules
- free-text rules
- timestamps
- last edited by

Every action should record:
- `rules_consulted`
- `rule_constraints_applied`
- `house_rules_snapshot_id` if implemented later

## Enforcement rule

Structured House Rules should make violations impossible by construction.

Free-text rules may be injected into action generation and cited, but should not be the only enforcement path for high-risk constraints.
