import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  sendEmail,
  isEmailEnabled,
  buildResendPayload,
} from "../app/lib/email/resend.server.js";
import {
  escapeHtml,
  interpolate,
  loadTemplateHtml,
} from "../app/lib/email/template.server.js";
import {
  deriveStoreName,
  renderWelcomeEmail,
  sendWelcomeEmailOnInstall,
} from "../app/lib/email/welcome.server.js";
import {
  hashRecipient,
  isEmailUnsubscribed,
  recordUnsubscribe,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../app/lib/email/unsubscribe.server.js";
import { ensureShopifyTenant } from "../app/lib/ingestion/shopify/tenant.server.js";

// Signed unsubscribe tokens need a secret; renderWelcomeEmail builds one when it
// renders the List-Unsubscribe URL, so the secret must be present in the test env.
process.env.EMAIL_UNSUBSCRIBE_SECRET =
  process.env.EMAIL_UNSUBSCRIBE_SECRET || "test-email-unsubscribe-secret";

const databaseUrl = process.env.DATABASE_URL;

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

// ---------------------------------------------------------------------------
// Adapter: ENABLE_EMAIL gating (proves no real send by default)
// ---------------------------------------------------------------------------

test("sendEmail is a no-op that never touches Resend when ENABLE_EMAIL is unset", async () => {
  await withEnv("ENABLE_EMAIL", undefined, async () => {
    await withEnv("RESEND_API_KEY", undefined, async () => {
      const result = await sendEmail({
        to: "merchant@example.com",
        subject: "Test subject",
        html: "<p>hi</p>",
      });

      assert.equal(result.disabled, true);
      assert.equal(result.delivered, false);
      assert.equal(result.id, null);
      assert.equal(isEmailEnabled(), false);
    });
  });
});

test("ENABLE_EMAIL enables only on a 'true' value (case/whitespace-insensitive)", async () => {
  // Anything that is not a "true"-like value leaves sending OFF (the safe default).
  for (const value of ["false", "0", "1", "yes", "on", "", undefined]) {
    await withEnv("ENABLE_EMAIL", value, async () => {
      assert.equal(isEmailEnabled(), false, `value=${JSON.stringify(value)}`);
    });
  }
  // Only a clear "true" (any case, surrounding whitespace tolerated) enables.
  for (const value of ["true", "TRUE", "True", " true "]) {
    await withEnv("ENABLE_EMAIL", value, async () => {
      assert.equal(isEmailEnabled(), true, `value=${JSON.stringify(value)}`);
    });
  }
});

test("buildResendPayload wires from + reply-to and omits absent optionals", () => {
  // Minimal input: only required fields survive; no replyTo/text/headers keys.
  const minimal = buildResendPayload({
    to: "m@example.com",
    subject: "S",
    html: "<p>x</p>",
    from: "Hola <hola@mynamejefe.com>",
  });
  assert.deepEqual(minimal, {
    from: "Hola <hola@mynamejefe.com>",
    to: "m@example.com",
    subject: "S",
    html: "<p>x</p>",
  });
  assert.ok(!("replyTo" in minimal), "no replyTo key when unset");

  // With a Reply-To: the visible sender stays Hola, replies route to a real inbox.
  const withReply = buildResendPayload({
    to: "m@example.com",
    subject: "S",
    html: "<p>x</p>",
    text: "x",
    headers: { "List-Unsubscribe": "<https://x>" },
    from: "Hola <hola@mynamejefe.com>",
    replyTo: "matt@mynamejefe.com",
  });
  assert.equal(withReply.replyTo, "matt@mynamejefe.com");
  assert.equal(withReply.from, "Hola <hola@mynamejefe.com>");
  assert.equal(withReply.text, "x");
  assert.deepEqual(withReply.headers, { "List-Unsubscribe": "<https://x>" });
});

test("sendEmail while enabled but without an API key still does not send", async () => {
  await withEnv("ENABLE_EMAIL", "true", async () => {
    await withEnv("RESEND_API_KEY", undefined, async () => {
      const result = await sendEmail({
        to: "m@example.com",
        subject: "S",
        html: "<p>x</p>",
      });
      assert.equal(result.delivered, false);
      assert.equal(result.disabled, false);
      assert.equal(result.skipped, "missing_api_key");
    });
  });
});

// ---------------------------------------------------------------------------
// Template layer: interpolation + escaping
// ---------------------------------------------------------------------------

test("interpolate replaces placeholders and HTML-escapes values", () => {
  const out = interpolate("<b>{{name}}</b> at {{url}}", {
    name: `<script>alert('x')</script>&"`,
    url: "https://x.test/a?b=1",
  });
  assert.ok(!out.includes("<script>"), "raw script tag must be escaped");
  assert.ok(out.includes("&lt;script&gt;"));
  assert.ok(out.includes("&amp;"));
  assert.ok(out.includes("&quot;"));
  assert.ok(out.includes("https://x.test/a?b=1"));
});

test("interpolate throws on an unresolved placeholder", () => {
  assert.throws(
    () => interpolate("hello {{missing}}", {}),
    /Unresolved email template variable/,
  );
});

test("escapeHtml escapes the five HTML-significant characters", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("deriveStoreName turns a shop domain into a human label", () => {
  assert.equal(
    deriveStoreName("northwind-supply.myshopify.com"),
    "Northwind Supply",
  );
  assert.equal(deriveStoreName("acme.myshopify.com"), "Acme");
  assert.equal(deriveStoreName(""), "your store");
});

// ---------------------------------------------------------------------------
// Welcome template: demo data replaced with real interpolation
// ---------------------------------------------------------------------------

test("welcome template ships with the Northwind/Maya demo values parameterised out", () => {
  const raw = loadTemplateHtml("jefe-welcome");
  for (const demo of [
    "Maya",
    "Northwind Supply",
    "maya@northwindsupply.com",
    "ONE_CLICK_TOKEN",
    // No hardcoded app/logo URL: every link is a {{placeholder}}, so our own
    // domain must never appear as a literal in the raw template.
    "mynamejefe.com",
  ]) {
    assert.ok(
      !raw.includes(demo),
      `raw template must not contain demo value "${demo}"`,
    );
  }
  // The placeholders that replaced them must be present.
  for (const placeholder of [
    "{{greeting}}",
    "{{storeName}}",
    "{{ctaUrl}}",
    "{{recipientEmail}}",
    "{{unsubscribeUrl}}",
    "{{logoUrl}}",
  ]) {
    assert.ok(raw.includes(placeholder), `expected ${placeholder}`);
  }
});

test("renderWelcomeEmail interpolates real merchant/store/link values", () => {
  const { subject, html, text, unsubscribeUrl } = renderWelcomeEmail({
    shopDomain: "acme-tools.myshopify.com",
    to: "owner@acme-tools.com",
    merchantName: "Sam",
    storeName: "Acme Tools",
    appUrl: "https://staging.jefe.test",
  });

  assert.equal(subject, "I'm in — here's what happens next on Acme Tools");
  assert.ok(html.includes("Alright, Sam — I'm in."));
  assert.ok(html.includes("Acme Tools is connected."));
  assert.ok(
    html.includes(
      'href="https://staging.jefe.test/?shop=acme-tools.myshopify.com"',
    ),
    "CTA deep-links into the embedded app via ?shop=",
  );
  // The welcome email must not link to /settings/* — no such route exists yet,
  // so those links 404 from the inbox. Interim: guardrails deep-links into the
  // app, email-preferences is the signed unsubscribe.
  assert.ok(!html.includes("/settings/"), "no dead /settings links");
  assert.ok(html.includes("https://staging.jefe.test/e/unsubscribe?t="));
  assert.ok(html.includes("owner@acme-tools.com"));
  assert.ok(!html.includes("{{"), "no unresolved placeholders");
  assert.ok(unsubscribeUrl.startsWith("https://staging.jefe.test/e/unsubscribe?t="));
  assert.ok(text.includes("Alright, Sam — I'm in."));
  assert.ok(
    text.includes("https://staging.jefe.test/?shop=acme-tools.myshopify.com"),
    "text CTA deep-links via ?shop=",
  );
});

test("renderWelcomeEmail drops the name gracefully when merchant is unknown", () => {
  const { html } = renderWelcomeEmail({
    shopDomain: "acme-tools.myshopify.com",
    to: "owner@acme-tools.com",
  });
  assert.ok(html.includes("Alright — I'm in."));
  // storeName falls back to the derived label.
  assert.ok(html.includes("Acme Tools is connected."));
});

test("sendWelcomeEmailOnInstall skips (without claiming) when no recipient is known", async () => {
  // prisma is never touched on this path, so a stub object is safe.
  const result = await sendWelcomeEmailOnInstall(
    /** @type {any} */ ({}),
    { shopDomain: "acme.myshopify.com", recipientEmail: null },
  );
  assert.equal(result.sent, false);
  assert.equal(result.reason, "no_recipient");
});

// ---------------------------------------------------------------------------
// Install trigger idempotency (DB-backed, still no real send)
// ---------------------------------------------------------------------------

test("welcome install trigger sends once per shop and is idempotent", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the welcome idempotency test");
    return;
  }

  await withEnv("ENABLE_EMAIL", undefined, async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
    const suffix = uniqueSuffix();
    const shopDomain = `welcome-${suffix}.myshopify.com`;

    try {
      await ensureShopifyTenant(prisma, {
        shopDomain,
        accessTokenSessionId: `offline-${suffix}`,
        scopes: ["read_products"],
      });

      const firstCall = await sendWelcomeEmailOnInstall(prisma, {
        shopDomain,
        recipientEmail: `owner-${suffix}@example.com`,
        merchantName: "Dana",
      });
      const secondCall = await sendWelcomeEmailOnInstall(prisma, {
        shopDomain,
        recipientEmail: `owner-${suffix}@example.com`,
        merchantName: "Dana",
      });

      // First call claims the guard and dispatches (as a disabled no-op); the
      // second is a no-op because the guard was already claimed. Together these
      // return values prove exactly one send was attempted across two triggers.
      assert.equal(firstCall.sent, true);
      assert.equal(firstCall.disabled, true, "must be a disabled no-op send");
      assert.equal(secondCall.sent, false);
      assert.equal(secondCall.reason, "already_sent");

      // The guard timestamp is set exactly once.
      const shop = await prisma.shop.findUniqueOrThrow({
        where: { platform_shopDomain: { platform: "shopify", shopDomain } },
        select: { welcomeEmailSentAt: true },
      });
      assert.ok(shop.welcomeEmailSentAt instanceof Date);
    } finally {
      await prisma.merchant.deleteMany({ where: { name: shopDomain } });
      await prisma.$disconnect();
    }
  });
});

test("welcome install trigger does not claim the guard when the shop is missing", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for this test");
    return;
  }

  const prisma = new PrismaClient({
    datasources: { db: { url: databaseUrl } },
  });
  try {
    const result = await sendWelcomeEmailOnInstall(prisma, {
      shopDomain: `missing-${uniqueSuffix()}.myshopify.com`,
      recipientEmail: "someone@example.com",
    });
    assert.equal(result.sent, false);
    assert.equal(result.reason, "shop_not_found");
  } finally {
    await prisma.$disconnect();
  }
});

// ---------------------------------------------------------------------------
// Unsubscribe: signed one-click tokens + suppression store
// ---------------------------------------------------------------------------

test("unsubscribe token round-trips shop domain + email hash", () => {
  const emailHash = hashRecipient("Owner@Acme-Tools.com");
  assert.ok(emailHash);
  const token = signUnsubscribeToken({
    shopDomain: "acme-tools.myshopify.com",
    emailHash,
  });
  assert.deepEqual(verifyUnsubscribeToken(token), {
    shopDomain: "acme-tools.myshopify.com",
    emailHash,
  });
});

test("unsubscribe token rejects tampering and malformed input", () => {
  const emailHash = hashRecipient("owner@acme.com") ?? "";
  const token = signUnsubscribeToken({
    shopDomain: "acme.myshopify.com",
    emailHash,
  });
  const [body, sig] = token.split(".");
  // A different payload signed with the original signature must not verify —
  // this is the core "can't forge an unsubscribe for someone else" property.
  const forgedBody = Buffer.from(
    JSON.stringify({ v: "u1", s: "evil.myshopify.com", h: emailHash }),
  ).toString("base64url");
  assert.equal(verifyUnsubscribeToken(`${forgedBody}.${sig}`), null);
  // Truncated signature, malformed, and missing tokens are all rejected.
  assert.equal(verifyUnsubscribeToken(`${body}.${sig.slice(0, 8)}`), null);
  assert.equal(verifyUnsubscribeToken("not-a-token"), null);
  assert.equal(verifyUnsubscribeToken(""), null);
  assert.equal(verifyUnsubscribeToken(null), null);
});

test("recordUnsubscribe suppresses a recipient (idempotent)", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the suppression test");
    return;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const shopDomain = `unsub-${suffix}.myshopify.com`;
  try {
    const { shop } = await ensureShopifyTenant(prisma, {
      shopDomain,
      accessTokenSessionId: `offline-${suffix}`,
      scopes: ["read_products"],
    });
    const emailHash = hashRecipient(`owner-${suffix}@example.com`);
    assert.ok(emailHash);

    assert.equal(
      await isEmailUnsubscribed(prisma, { shopId: shop.id, emailHash }),
      false,
    );
    await recordUnsubscribe(prisma, { shopId: shop.id, emailHash, source: "test" });
    assert.equal(
      await isEmailUnsubscribed(prisma, { shopId: shop.id, emailHash }),
      true,
    );
    // Second call is idempotent (upsert), still unsubscribed.
    await recordUnsubscribe(prisma, { shopId: shop.id, emailHash, source: "test" });
    assert.equal(
      await isEmailUnsubscribed(prisma, { shopId: shop.id, emailHash }),
      true,
    );
  } finally {
    await prisma.merchant.deleteMany({ where: { name: shopDomain } });
    await prisma.$disconnect();
  }
});

test("welcome install trigger skips an unsubscribed recipient without claiming the guard", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for the unsubscribe-skip test");
    return;
  }
  await withEnv("ENABLE_EMAIL", undefined, async () => {
    const prisma = new PrismaClient({
      datasources: { db: { url: databaseUrl } },
    });
    const suffix = uniqueSuffix();
    const shopDomain = `unsub-skip-${suffix}.myshopify.com`;
    const recipient = `owner-${suffix}@example.com`;
    try {
      const { shop } = await ensureShopifyTenant(prisma, {
        shopDomain,
        accessTokenSessionId: `offline-${suffix}`,
        scopes: ["read_products"],
      });
      await recordUnsubscribe(prisma, {
        shopId: shop.id,
        emailHash: hashRecipient(recipient),
        source: "test",
      });

      const result = await sendWelcomeEmailOnInstall(prisma, {
        shopDomain,
        recipientEmail: recipient,
      });
      assert.equal(result.sent, false);
      assert.equal(result.reason, "unsubscribed");

      // An unsubscribe is not a "sent" — the welcome guard must stay unclaimed.
      const shopRow = await prisma.shop.findUniqueOrThrow({
        where: { platform_shopDomain: { platform: "shopify", shopDomain } },
        select: { welcomeEmailSentAt: true },
      });
      assert.equal(shopRow.welcomeEmailSentAt, null);
    } finally {
      await prisma.merchant.deleteMany({ where: { name: shopDomain } });
      await prisma.$disconnect();
    }
  });
});
