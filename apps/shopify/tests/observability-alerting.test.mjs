import assert from "node:assert/strict";
import test from "node:test";
import { createAlerter } from "../app/lib/observability/alerting.server.js";

function fakeFetch() {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true };
  };
  fn.calls = calls;
  return fn;
}

const RECORD = {
  level: "error",
  msg: "Unhandled server error",
  err: { name: "TypeError", message: "x is not a function" },
  path: "/app",
};

test("is disabled (no-op) when no webhook URL is configured", () => {
  const fetch = fakeFetch();
  const alerter = createAlerter({ env: {}, fetch });
  assert.equal(alerter.enabled, false);
  alerter.notify(RECORD);
  assert.equal(fetch.calls.length, 0);
});

test("posts a Slack-shaped payload on an error record", () => {
  const fetch = fakeFetch();
  const alerter = createAlerter({
    webhookUrl: "https://hooks.example.com/x",
    env: { APP_ENV: "production" },
    fetch,
    now: () => 1000,
  });
  alerter.notify(RECORD);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://hooks.example.com/x");
  assert.match(fetch.calls[0].body.text, /Unhandled server error/);
  assert.match(fetch.calls[0].body.text, /production/);
  assert.match(fetch.calls[0].body.text, /TypeError/);
});

test("de-duplicates identical failures within the cooldown window", () => {
  let t = 0;
  const fetch = fakeFetch();
  const alerter = createAlerter({
    webhookUrl: "https://hooks.example.com/x",
    fetch,
    now: () => t,
    cooldownMs: 1000,
  });
  alerter.notify(RECORD); // sent
  t = 500;
  alerter.notify(RECORD); // within cooldown -> suppressed
  t = 1500;
  alerter.notify(RECORD); // cooldown elapsed -> sent
  assert.equal(fetch.calls.length, 2);
});

test("distinct failures are not de-duplicated against each other", () => {
  const fetch = fakeFetch();
  const alerter = createAlerter({
    webhookUrl: "https://hooks.example.com/x",
    fetch,
    now: () => 0,
  });
  alerter.notify(RECORD);
  alerter.notify({ ...RECORD, err: { name: "RangeError", message: "boom" } });
  assert.equal(fetch.calls.length, 2);
});

test("enforces a per-window cap to prevent alert storms", () => {
  const fetch = fakeFetch();
  const alerter = createAlerter({
    webhookUrl: "https://hooks.example.com/x",
    fetch,
    now: () => 0,
    maxPerWindow: 3,
  });
  for (let i = 0; i < 10; i += 1) {
    // Unique signature each time so the cooldown never suppresses.
    alerter.notify({ ...RECORD, path: `/app/${i}` });
  }
  assert.equal(fetch.calls.length, 3);
});

test("never throws when the webhook fetch rejects", () => {
  const rejectingFetch = () => Promise.reject(new Error("network down"));
  const alerter = createAlerter({
    webhookUrl: "https://hooks.example.com/x",
    fetch: rejectingFetch,
    now: () => 0,
  });
  assert.doesNotThrow(() => alerter.notify(RECORD));
});
