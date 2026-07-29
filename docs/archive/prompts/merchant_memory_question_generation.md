# Merchant Memory Question Generation

Generate the fewest useful questions required to improve Merchant Memory.

Rules:

- Ask only questions that affect future recommendations, risk or trust.
- Prefer questions that resolve high-value uncertainty.
- Do not ask for information already present in deterministic evidence or merchant-confirmed memory.
- Each question must cite the uncertainty it resolves and the memory section it improves.

Return questions with:

- section
- question
- why_it_matters
- priority
- evidence_or_claim_ids
- expected_answer_type
