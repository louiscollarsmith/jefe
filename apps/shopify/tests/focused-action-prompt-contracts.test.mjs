import test from "node:test";
import assert from "node:assert/strict";

import {
  ACTION_AGENT_PROMPT_VERSION,
  buildActionAgentSystemPrompt,
} from "../app/lib/actions/agent/agent-loop.server.js";
import { toolNamesForKind } from "../app/lib/actions/agent/tool-registry.server.js";
import {
  ACTION_REPLANNER_PROMPT_VERSION,
  ACTION_REPLANNER_SYSTEM_PROMPT,
} from "../app/lib/actions/action-replanner.server.js";
import {
  SUPPLIER_EMAIL_ARTIFACT_PROMPT_VERSION,
  runSupplierEmailDraftAssist,
} from "../app/lib/actions/assist-steps/handlers/supplier-email-draft.server.js";

test("focused action prompt is constructed from the current callable tool catalogue", () => {
  assert.equal(ACTION_AGENT_PROMPT_VERSION, "3-catalogue-scoped");

  const markdownPrompt = buildActionAgentSystemPrompt({
    kind: "markdown",
    availableTools: toolNamesForKind("markdown"),
  });
  assert.doesNotMatch(markdownPrompt, /discover_product_type_scope/);
  assert.doesNotMatch(markdownPrompt, /add_product_to_scope/);
  assert.doesNotMatch(markdownPrompt, /draft_supplier_email/);
  assert.match(markdownPrompt, /Never call a tool not listed/);
  assert.match(markdownPrompt, /actionState is authoritative/);

  const listingPrompt = buildActionAgentSystemPrompt({
    kind: "listing_copy",
    availableTools: toolNamesForKind("listing_copy"),
  });
  assert.match(listingPrompt, /discover_product_type_scope/);

  const restockPrompt = buildActionAgentSystemPrompt({
    kind: "restock",
    availableTools: toolNamesForKind("restock"),
  });
  assert.match(restockPrompt, /add_product_to_scope/);
  assert.match(restockPrompt, /draft_supplier_email/);
});

test("action replanner prompt requires semantic workspace output and unprogressable failures", () => {
  assert.equal(ACTION_REPLANNER_PROMPT_VERSION, "action_replanner:v3");
  assert.match(ACTION_REPLANNER_SYSTEM_PROMPT, /desired semantic workflow/);
  assert.match(ACTION_REPLANNER_SYSTEM_PROMPT, /UNPROGRESSABLE/);
  assert.match(
    ACTION_REPLANNER_SYSTEM_PROMPT,
    /Do not convert an unsupported Jefe operation into a merchant-owned task/,
  );
  assert.doesNotMatch(
    ACTION_REPLANNER_SYSTEM_PROMPT,
    /model purchase orders as merchant_action/,
  );
  assert.doesNotMatch(
    ACTION_REPLANNER_SYSTEM_PROMPT,
    /leave capabilityRef null and use mode merchant_action/,
  );
});

test("supplier email artifact prompt uses current canonical action inputs only", async () => {
  let capturedRequest = null;
  const provider = {
    async generateStructuredJson(request) {
      capturedRequest = request;
      return {
        json: {
          summary: "Drafted a supplier email covering 1 item.",
          detail: "Review before sending.",
          nextPrompt: "Want any changes?",
          body: "Hi,\n\nCould we please order Picnic Blanket: 4 units?\n\nThanks,",
          items: [{ title: "Picnic Blanket", units: 4 }],
        },
      };
    },
  };

  const result = await runSupplierEmailDraftAssist({
    provider,
    step: { title: "Draft supplier email" },
    resolvedContext: {
      canonicalProposal: {
        revision: 2,
        inputFingerprint: "proposal-fingerprint",
        coverDays: 90,
        items: [{ title: "Picnic Blanket", recommendedUnits: 4 }],
      },
      scope: { excluded: [] },
      plan: { values: { coverDays: 90 } },
    },
  });

  assert.equal(result.progress.promptVersion, SUPPLIER_EMAIL_ARTIFACT_PROMPT_VERSION);
  assert.match(
    capturedRequest.systemPrompt.join("\n"),
    /CURRENT canonical Action inputs/,
  );
  assert.match(capturedRequest.systemPrompt.join("\n"), /Do not change the Action/);
  assert.equal(
    JSON.parse(capturedRequest.prompt).promptVersion,
    SUPPLIER_EMAIL_ARTIFACT_PROMPT_VERSION,
  );
});
