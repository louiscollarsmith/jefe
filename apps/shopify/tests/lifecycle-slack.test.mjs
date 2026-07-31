import assert from "node:assert/strict";
import test from "node:test";
import {
  formatLifecycleText,
  notifyShopLifecycleToSlack,
} from "../app/lib/observability/lifecycle-slack.server.js";

test("formatLifecycleText: install line", () => {
  const t = formatLifecycleText({ event: "installed", shopDomain: "acme.myshopify.com" });
  assert.match(t, /🎉/);
  assert.match(t, /installed/);
  assert.match(t, /acme\.myshopify\.com/);
});

test("formatLifecycleText: reinstall is distinct from a fresh install", () => {
  const t = formatLifecycleText({ event: "installed", shopDomain: "acme.myshopify.com", reinstall: true });
  assert.match(t, /re-installed/);
  assert.match(t, /came back/);
});

test("formatLifecycleText: uninstall with tenure (plural + singular)", () => {
  assert.match(
    formatLifecycleText({ event: "uninstalled", shopDomain: "acme.myshopify.com", daysInstalled: 5 }),
    /👋 .*uninstalled.*acme\.myshopify\.com.*after 5 days/,
  );
  assert.match(
    formatLifecycleText({ event: "uninstalled", shopDomain: "a.myshopify.com", daysInstalled: 1 }),
    /after 1 day\b/,
  );
});

test("formatLifecycleText: uninstall without tenure omits the parenthetical", () => {
  const t = formatLifecycleText({ event: "uninstalled", shopDomain: "a.myshopify.com", daysInstalled: null });
  assert.doesNotMatch(t, /after/);
});

test("notifyShopLifecycleToSlack: no-op (no post) when the webhook is unset", async () => {
  let called = false;
  const res = await notifyShopLifecycleToSlack(
    { event: "installed", shopDomain: "a.myshopify.com" },
    { webhookUrl: "", fetchImpl: async () => { called = true; return { ok: true }; } },
  );
  assert.deepEqual(res, { sent: false, reason: "disabled" });
  assert.equal(called, false, "must not hit the network when disabled");
});

test("notifyShopLifecycleToSlack: posts a {text} payload to the webhook on 2xx", async () => {
  let captured = null;
  const res = await notifyShopLifecycleToSlack(
    { event: "uninstalled", shopDomain: "acme.myshopify.com", daysInstalled: 3 },
    {
      webhookUrl: "https://hooks.slack.test/x",
      fetchImpl: async (url, opts) => {
        captured = { url, method: opts.method, body: JSON.parse(opts.body) };
        return { ok: true, status: 200 };
      },
    },
  );
  assert.deepEqual(res, { sent: true });
  assert.equal(captured.url, "https://hooks.slack.test/x");
  assert.equal(captured.method, "POST");
  assert.match(captured.body.text, /uninstalled/);
  assert.match(captured.body.text, /acme\.myshopify\.com/);
});

test("notifyShopLifecycleToSlack: reports a non-2xx, never throws", async () => {
  const res = await notifyShopLifecycleToSlack(
    { event: "installed", shopDomain: "a.myshopify.com" },
    { webhookUrl: "https://hooks.slack.test/x", fetchImpl: async () => ({ ok: false, status: 500 }) },
  );
  assert.deepEqual(res, { sent: false, reason: "http_500" });
});

test("notifyShopLifecycleToSlack: swallows a fetch error (must not break install/uninstall)", async () => {
  const res = await notifyShopLifecycleToSlack(
    { event: "installed", shopDomain: "a.myshopify.com" },
    { webhookUrl: "https://hooks.slack.test/x", fetchImpl: async () => { throw new Error("network down"); } },
  );
  assert.deepEqual(res, { sent: false, reason: "error" });
});
