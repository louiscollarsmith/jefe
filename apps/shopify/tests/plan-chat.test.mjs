import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAN_CHAT_INTENT,
  buildPlanScopeReply,
  buildPlanStatusReply,
  classifyPlanChatIntent,
} from "../app/lib/actions/plan-chat.server.js";

test("plan chat classifies the demo conversation turns", () => {
  assert.equal(
    classifyPlanChatIntent("Tell me more about this plan please?"),
    PLAN_CHAT_INTENT.recap,
  );
  assert.equal(
    classifyPlanChatIntent("ok lets go ahead and start that step please"),
    PLAN_CHAT_INTENT.start,
  );
  assert.equal(
    classifyPlanChatIntent("what are the unassigned products?"),
    PLAN_CHAT_INTENT.scope,
  );
  assert.equal(classifyPlanChatIntent("Start this"), PLAN_CHAT_INTENT.start);
  assert.equal(classifyPlanChatIntent("How's it going?"), PLAN_CHAT_INTENT.status);
  assert.equal(classifyPlanChatIntent("Stop this"), PLAN_CHAT_INTENT.stop);
  assert.equal(classifyPlanChatIntent("That's done"), PLAN_CHAT_INTENT.complete);
  assert.equal(classifyPlanChatIntent("skip this step"), PLAN_CHAT_INTENT.skip);
  assert.equal(classifyPlanChatIntent("Accept this plan"), PLAN_CHAT_INTENT.accept);
  assert.equal(classifyPlanChatIntent("Don't do this"), PLAN_CHAT_INTENT.decline);
  assert.equal(classifyPlanChatIntent("What will you change?"), PLAN_CHAT_INTENT.scope);
  assert.equal(
    classifyPlanChatIntent("what happens when you start that step?"),
    PLAN_CHAT_INTENT.question,
  );
});

test("plan status reply describes the current step instead of recapping", () => {
  const reply = buildPlanStatusReply({
    title: "Categorise Catalogue Products",
    status: "accepted",
    currentStep: { title: "Categorise unassigned products", status: "ready" },
  });
  assert.match(reply, /ready/i);
  assert.match(reply, /Categorise unassigned products/);
  assert.doesNotMatch(reply, /The plan:/);
});

test("plan scope reply lists listing-copy products from the preview", () => {
  const reply = buildPlanScopeReply({
    title: "Categorise Catalogue Products",
    actionType: "listing_copy",
    progress: {
      preview: {
        changes: [
          { title: "Hawkstone Lager", toType: "Beer" },
          { title: "House Red", toType: "Wine" },
        ],
      },
    },
  });
  assert.match(reply, /Hawkstone Lager/);
  assert.match(reply, /Beer/);
  assert.match(reply, /House Red/);
  assert.doesNotMatch(reply, /The plan:/);
});

test("plan scope reply admits when no products are attached", () => {
  const reply = buildPlanScopeReply({
    title: "Categorise Catalogue Products",
    actionType: "listing_copy",
  });
  assert.match(reply, /don.t have the product list/i);
});
