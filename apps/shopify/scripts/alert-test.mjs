#!/usr/bin/env node
// Fire a single test alert through the real logging → alerting pipeline, to
// confirm ops alerts land in your Slack channel (e.g. #jefe-slack).
//
//   cd apps/shopify
//   ALERT_WEBHOOK_URL="https://hooks.slack.com/services/XXX/YYY/ZZZ" npm run alert:test
//
// It emits an error-level log, which the default logger forwards to the alerter,
// which POSTs to ALERT_WEBHOOK_URL. If the webhook points at #jefe-slack, a
// message appears there. Uses the exact same code path as a real production
// error — no special-casing.

import { logger } from "../app/lib/observability/logger.server.js";

if (!process.env.ALERT_WEBHOOK_URL) {
  console.error(
    "alert-test: ALERT_WEBHOOK_URL is not set — nothing to test.\n" +
      "Create a Slack Incoming Webhook for your channel and re-run:\n" +
      '  ALERT_WEBHOOK_URL="https://hooks.slack.com/services/…" npm run alert:test',
  );
  process.exit(1);
}

// A synthetic error, carrying a redaction sample so you can confirm scrubbing
// works end-to-end (the token and email below must NOT appear in Slack).
const error = new Error("Test alert from `npm run alert:test` — ops alerting is wired up.");
error.name = "AlertTest";

logger.error("Ops alerting test", {
  err: error,
  component: "alert-test",
  accessToken: "should-be-redacted",
  contactEmail: "should-be-redacted@example.com",
});

console.log(
  "Test alert emitted. Check your Slack channel — you should see an :rotating_light: message,\n" +
    "and the token/email above should appear redacted. (Giving the webhook POST a moment…)",
);

// The webhook POST is fire-and-forget; wait briefly so it completes before exit.
await new Promise((resolve) => setTimeout(resolve, 2000));
