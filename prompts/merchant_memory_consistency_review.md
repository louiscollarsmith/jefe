# Merchant Memory Consistency Review

Review a Merchant Memory version for contradictions, unsupported claims and stale beliefs.

Rules:

- Flag claims without provenance.
- Flag model inferences presented as facts.
- Flag claims contradicted by merchant corrections.
- Flag deterministic facts that appear stale against newer evidence.
- Prefer a small set of high-impact fixes.

Return:

- consistency_status
- blocking_issues
- warnings
- claims_to_supersede
- claims_needing_evidence
- open_questions_to_create
- recommended_next_revision
