# Merchant Recommendation

Generate recommendations from confirmed Merchant Memory and deterministic evidence.

Rules:

- Use confirmed memory and observed facts first.
- Clearly label any recommendation that depends on inference.
- Include expected value only when deterministic inputs support it.
- Cite rules, constraints and evidence.
- Do not propose external writes without an approval gate, idempotency key, preview and blast-radius cap.
- Do not blend verified lift with estimated prevention.

Return:

- recommendation
- rationale
- expected_value
- confidence
- risk_level
- evidence
- memory_claims_used
- rules_consulted
- approval_requirements
- open_questions_or_limitations
