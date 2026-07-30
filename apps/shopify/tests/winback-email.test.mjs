import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import { loadTemplateHtml } from "../app/lib/email/template.server.js";
import {
  FEEDBACK_REASONS,
  isFeedbackReason,
  signFeedbackToken,
  verifyFeedbackToken,
} from "../app/lib/email/feedback.server.js";
import {
  SUBJECT_OPTIONS,
  clearWinBackGuard,
  isWinBackEmailEnabled,
  renderWinBackEmail,
  resolveWinBackRecipient,
  sendWinBackEmailOnUninstall,
} from "../app/lib/email/winback.server.js";
import { hashRecipient } from "../app/lib/email/unsubscribe.server.js";
import { ensureShopifyTenant } from "../app/lib/ingestion/shopify/tenant.server.js";

// Signed feedback + unsubscribe tokens need a secret; renderWinBackEmail builds
// both when it renders the links, so the secret must be present in the test env.
process.env.EMAIL_UNSUBSCRIBE_SECRET =
  process.env.EMAIL_UNSUBSCRIBE_SECRET || "test-email-unsubscribe-secret";

const databaseUrl = process.env.DATABASE_URL;

/** Run `fn` with console.log/console.warn/console.error captured (and silenced). */
async function withCapturedConsole(fn) {
  const logs = [];
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => logs.push(args.join(" "));
  console.error = (...args) => logs.push(args.join(" "));
  try {
    const result = await fn();
    return { result, logs };
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

/** Save/restore an env var around a callback. */
async function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[key] = previous;
    else delete process.env[key];
  }
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`.replace(
    /[^a-z0-9-]/gi,
    "",
  );
}

/** Poll for a fire-and-forget activity event (track() is not awaited). Generous
 * window so a cold Prisma engine on the first suite run can't flake the assert. */
async function waitForEvents(prisma, where, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    const rows = await prisma.activityEvent.findMany({ where });
    if (rows.length > 0) return rows;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Feedback tokens: locked reason codes + signed one-tap round-trip
// ---------------------------------------------------------------------------

test("feedback reason codes are the four locked keys", () => {
  assert.deepEqual(Object.keys(FEEDBACK_REASONS).sort(), [
    "broke",
    "no_value",
    "too_complex",
    "too_early",
  ]);
  assert.equal(isFeedbackReason("too_early"), true);
  assert.equal(isFeedbackReason("nope"), false);
});

test("feedback token round-trips shop domain + email hash + reason", () => {
  const emailHash = hashRecipient("Owner@Acme-Tools.com") ?? "";
  const token = signFeedbackToken({
    shopDomain: "acme-tools.myshopify.com",
    emailHash,
    reason: "too_complex",
  });
  assert.deepEqual(verifyFeedbackToken(token), {
    shopDomain: "acme-tools.myshopify.com",
    emailHash,
    reason: "too_complex",
  });
});

test("signFeedbackToken refuses an unknown reason", () => {
  assert.throws(
    () =>
      signFeedbackToken({
        shopDomain: "acme.myshopify.com",
        emailHash: "h",
        reason: "because",
      }),
    /Unknown feedback reason/,
  );
});

test("feedback token rejects tampering, a swapped reason, and malformed input", () => {
  const emailHash = hashRecipient("owner@acme.com") ?? "";
  const token = signFeedbackToken({
    shopDomain: "acme.myshopify.com",
    emailHash,
    reason: "broke",
  });
  const [body, sig] = token.split(".");
  // Re-attributing the same signature to a different store/reason must not verify.
  const forgedBody = Buffer.from(
    JSON.stringify({ v: "f1", s: "evil.myshopify.com", h: emailHash, r: "broke" }),
  ).toString("base64url");
  assert.equal(verifyFeedbackToken(`${forgedBody}.${sig}`), null);
  assert.equal(verifyFeedbackToken(`${body}.${sig.slice(0, 8)}`), null);
  assert.equal(verifyFeedbackToken("not-a-token"), null);
  assert.equal(verifyFeedbackToken(""), null);
  assert.equal(verifyFeedbackToken(null), null);
});

// ---------------------------------------------------------------------------
// Win-back template: no demo data, all placeholders present
// ---------------------------------------------------------------------------

test("winback template is fully parameterised (no demo values, all placeholders)", () => {
  const raw = loadTemplateHtml("jefe-winback");
  for (const demo of ["Maya", "Northwind", "ONE_CLICK_TOKEN"]) {
    assert.ok(!raw.includes(demo), `raw template must not contain "${demo}"`);
  }
  for (const placeholder of [
    "{{greeting}}",
    "{{storeName}}",
    "{{daysDetail}}",
    "{{reinstallUrl}}",
    "{{feedbackTooEarlyUrl}}",
    "{{feedbackNoValueUrl}}",
    "{{feedbackTooComplexUrl}}",
    "{{feedbackBrokeUrl}}",
    "{{unsubscribeUrl}}",
    "{{recipientEmail}}",
    "{{logoUrl}}",
  ]) {
    assert.ok(raw.includes(placeholder), `expected ${placeholder}`);
  }
});

test("renderWinBackEmail interpolates merchant/store/link values", () => {
  const { subject, html, text, unsubscribeUrl } = renderWinBackEmail({
    shopDomain: "acme-tools.myshopify.com",
    to: "owner@acme-tools.com",
    merchantName: "Sam",
    storeName: "Acme Tools",
    daysInstalled: 12,
    appUrl: "https://staging.jefe.test",
  });

  assert.equal(subject, SUBJECT_OPTIONS[0]);
  assert.ok(html.includes("Sam — no hard feelings."));
  assert.ok(html.includes("uninstalled me from Acme Tools"));
  assert.ok(html.includes("over 12 days"), "tenure line rendered");
  // One signed feedback link per locked reason, all on the app origin.
  for (const _ of Object.keys(FEEDBACK_REASONS)) {
    assert.ok(html.includes("https://staging.jefe.test/e/feedback?t="));
  }
  assert.equal(
    html.split("https://staging.jefe.test/e/feedback?t=").length - 1,
    4,
    "exactly four feedback links",
  );
  assert.ok(
    html.includes('href="https://staging.jefe.test/?shop=acme-tools.myshopify.com"'),
    "reconnect deep-links via ?shop=",
  );
  assert.ok(html.includes("https://staging.jefe.test/e/unsubscribe?t="));
  assert.ok(html.includes("owner@acme-tools.com"));
  assert.ok(!html.includes("{{"), "no unresolved placeholders");
  assert.ok(
    unsubscribeUrl.startsWith("https://staging.jefe.test/e/unsubscribe?t="),
  );
  assert.ok(text.includes("Sam — no hard feelings."));
  assert.ok(text.includes("over 12 days"));
});

test("renderWinBackEmail degrades gracefully with no name and no tenure", () => {
  const { html } = renderWinBackEmail({
    shopDomain: "acme-tools.myshopify.com",
    to: "owner@acme-tools.com",
  });
  assert.ok(html.includes("Right then — no hard feelings."));
  assert.ok(html.includes("uninstalled me from Acme Tools"));
  assert.ok(!html.includes(" over "), "no tenure line when days unknown");
});

// ---------------------------------------------------------------------------
// Uninstall trigger: recipient resolution + skip-without-claim
// ---------------------------------------------------------------------------

test("resolveWinBackRecipient maps the chosen session; null when no email", async () => {
  const withEmail = await resolveWinBackRecipient(
    /** @type {any} */ ({
      session: {
        findMany: async () => [
          { email: "owner@acme.com", firstName: "Dana", accountOwner: true },
        ],
      },
    }),
    "acme.myshopify.com",
  );
  assert.deepEqual(withEmail, { email: "owner@acme.com", firstName: "Dana" });

  const none = await resolveWinBackRecipient(
    /** @type {any} */ ({ session: { findMany: async () => [] } }),
    "acme.myshopify.com",
  );
  assert.equal(none, null);
});

test("win-back is dark by default and only enables on ENABLE_WINBACK_EMAIL=true", async () => {
  await withEnv("ENABLE_WINBACK_EMAIL", undefined, async () => {
    assert.equal(isWinBackEmailEnabled(), false);
    // A poisoned prisma proves the disabled path touches nothing (no lookup,
    // no guard claim) — it returns before any DB access.
    const prisma = /** @type {any} */ ({
      session: {
        findMany: async () => {
          throw new Error("must not query while win-back is disabled");
        },
      },
    });
    const result = await sendWinBackEmailOnUninstall(prisma, {
      shopDomain: "acme.myshopify.com",
      shopId: "shop-1",
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, "winback_disabled");
  });
  for (const value of ["true", "TRUE", " true "]) {
    await withEnv("ENABLE_WINBACK_EMAIL", value, async () => {
      assert.equal(isWinBackEmailEnabled(), true, `value=${JSON.stringify(value)}`);
    });
  }
});

test("sendWinBackEmailOnUninstall skips (without claiming) when no recipient resolves", async () => {
  await withEnv("ENABLE_WINBACK_EMAIL", "true", async () => {
    // session.findMany returns []; shop is never touched, so a stub is safe and
    // proves the guard-claim is skipped before any updateMany.
    const prisma = /** @type {any} */ ({
      session: { findMany: async () => [] },
    });
    const { result } = await withCapturedConsole(() =>
      sendWinBackEmailOnUninstall(prisma, {
        shopDomain: "acme.myshopify.com",
        shopId: "shop-1",
      }),
    );
    assert.equal(result.sent, false);
    assert.equal(result.reason, "no_recipient");
  });
});

// ---------------------------------------------------------------------------
// Uninstall trigger idempotency (DB-backed, still no real send)
// ---------------------------------------------------------------------------

test("winback uninstall trigger sends once per shop and is idempotent", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the winback idempotency test");
    return;
  }

  // ENABLE_WINBACK_EMAIL=true clears the dark switch; ENABLE_EMAIL stays unset so
  // the actual Resend call is a logging no-op (proves the trigger, not delivery).
  await withEnv("ENABLE_WINBACK_EMAIL", "true", async () =>
   withEnv("ENABLE_EMAIL", undefined, async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
    const suffix = uniqueSuffix();
    const shopDomain = `winback-${suffix}.myshopify.com`;
    const recipient = `owner-${suffix}@example.com`;

    try {
      const { shop } = await ensureShopifyTenant(prisma, {
        shopDomain,
        accessTokenSessionId: `offline-${suffix}`,
        scopes: ["read_products"],
      });
      // The uninstall path resolves the recipient from a persisted Session.
      await prisma.session.create({
        data: {
          id: `sess-${suffix}`,
          shop: shopDomain,
          state: "x",
          accessToken: "tok",
          isOnline: true,
          email: recipient,
          firstName: "Dana",
          accountOwner: true,
        },
      });

      const { result, logs } = await withCapturedConsole(async () => {
        const a = await sendWinBackEmailOnUninstall(prisma, {
          shopDomain,
          shopId: shop.id,
        });
        const b = await sendWinBackEmailOnUninstall(prisma, {
          shopDomain,
          shopId: shop.id,
        });
        return [a, b];
      });
      const [first, second] = result;

      assert.equal(first.sent, true);
      assert.equal(first.disabled, true, "must be a disabled no-op send");
      assert.equal(second.sent, false);
      assert.equal(second.reason, "already_sent");

      const sendAttempts = logs.filter((line) =>
        line.includes("[email disabled] would send"),
      );
      assert.equal(sendAttempts.length, 1, "exactly one send attempt");

      const shopRow = await prisma.shop.findUniqueOrThrow({
        where: { platform_shopDomain: { platform: "shopify", shopDomain } },
        select: { winbackEmailSentAt: true },
      });
      assert.ok(shopRow.winbackEmailSentAt instanceof Date);

      // The single dispatch emitted one PII-free health event.
      const events = await waitForEvents(prisma, {
        shopId: shop.id,
        type: "email_sent",
      });
      assert.equal(events.length, 1, "one email_sent event for one dispatch");
      assert.equal(events[0].properties.kind, "winback");
      assert.equal(events[0].properties.disabled, true);
    } finally {
      await prisma.activityEvent
        .deleteMany({ where: { shopDomain } })
        .catch(() => {});
      await prisma.session.deleteMany({ where: { shop: shopDomain } });
      await prisma.merchant.deleteMany({ where: { name: shopDomain } });
      await prisma.$disconnect();
    }
  }));
});

test("clearWinBackGuard clears a set guard on reinstall and no-ops otherwise", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the clearWinBackGuard test");
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const shopDomain = `winback-clear-${suffix}.myshopify.com`;
  try {
    const { shop } = await ensureShopifyTenant(prisma, {
      shopDomain,
      accessTokenSessionId: `offline-${suffix}`,
      scopes: ["read_products"],
    });

    // No guard set yet -> no-op clear.
    assert.deepEqual(await clearWinBackGuard(prisma, shopDomain), { cleared: 0 });

    // Guard set (a prior farewell) -> reinstall clears it so a re-churn re-sends.
    await prisma.shop.update({
      where: { id: shop.id },
      data: { winbackEmailSentAt: new Date() },
    });
    assert.deepEqual(await clearWinBackGuard(prisma, shopDomain), { cleared: 1 });
    const row = await prisma.shop.findUniqueOrThrow({
      where: { id: shop.id },
      select: { winbackEmailSentAt: true },
    });
    assert.equal(row.winbackEmailSentAt, null);

    // Idempotent: clearing an already-clear guard is a no-op.
    assert.deepEqual(await clearWinBackGuard(prisma, shopDomain), { cleared: 0 });
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});
