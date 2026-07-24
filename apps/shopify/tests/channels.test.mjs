import assert from "node:assert/strict";
import test from "node:test";
import { PrismaClient } from "@prisma/client";
import {
  CHANNEL_STATUS,
  completeSlackConnection,
  completeSlackConnectionFromState,
  confirmWhatsAppVerification,
  disconnectChannelConnection,
  hasVerifiedChannelConnection,
  listChannelConnections,
  listSlackDestinations,
  resetPendingSlackAuthorisations,
  selectSlackDestinationAndSendWelcome,
  sendChannelTestMessage,
  startSlackConnection,
  startWhatsAppVerification,
} from "../app/lib/channels/service.server.js";
import {
  decryptChannelCredentialPayload,
  encryptChannelCredentialPayload,
  hashVerificationCode,
  verifyVerificationCode,
} from "../app/lib/channels/crypto.server.js";
import { normalisePhoneToE164 } from "../app/lib/channels/phone.server.js";

const databaseUrl = process.env.DATABASE_URL;
const channelEnv = {
  CHANNEL_CREDENTIAL_ENCRYPTION_SECRET: "channel-credential-secret-for-tests",
  CHANNEL_VERIFICATION_SECRET: "channel-verification-secret-for-tests",
  SLACK_CLIENT_ID: "slack-client",
  SLACK_CLIENT_SECRET: "slack-secret",
  SHOPIFY_APP_URL: "https://jefe.test",
  WHATSAPP_PROVIDER: "meta",
  META_WHATSAPP_ACCESS_TOKEN: "meta-test-token",
  META_WHATSAPP_PHONE_NUMBER_ID: "1234567890",
  META_WHATSAPP_VERIFICATION_TEMPLATE_NAME: "jefe_verification",
  META_WHATSAPP_MESSAGE_TEMPLATE_NAME: "jefe_message",
};

test("channel credential encryption and verification hashes do not expose secrets", () => {
  const encrypted = encryptChannelCredentialPayload(
    { accessToken: "xoxb-super-secret" },
    channelEnv,
  );
  assert.doesNotMatch(encrypted, /xoxb-super-secret/);
  assert.deepEqual(decryptChannelCredentialPayload(encrypted, channelEnv), {
    accessToken: "xoxb-super-secret",
  });

  const codeHash = hashVerificationCode("123456", "+447123456789", channelEnv);
  assert.doesNotMatch(codeHash, /123456/);
  assert.equal(verifyVerificationCode("123456", "+447123456789", codeHash, channelEnv), true);
  assert.equal(verifyVerificationCode("000000", "+447123456789", codeHash, channelEnv), false);
});

test("WhatsApp phone numbers are normalised to E.164", () => {
  assert.equal(
    normalisePhoneToE164({ countryCode: "GB", phoneNumber: "07123 456789" }),
    "+447123456789",
  );
  assert.equal(
    normalisePhoneToE164({ phoneNumber: "+1 (555) 123-4567" }),
    "+15551234567",
  );
  assert.throws(
    () => normalisePhoneToE164({ countryCode: "GB", phoneNumber: "12" }),
    /valid international mobile number/i,
  );
});

test("Slack OAuth state is tenant-bound, short-lived and single-use", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for channel integration tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const slackAdapter = new MockSlackAdapter();

  try {
    const first = await createChannelFixture(prisma, suffix, "first");
    const second = await createChannelFixture(prisma, suffix, "second");
    const started = await startSlackConnection(prisma, {
      merchantId: first.merchant.id,
      shopId: first.shop.id,
      requestUrl: `https://jefe.test/app?shop=${first.shop.shopDomain}&host=test`,
      env: channelEnv,
      adapter: slackAdapter,
      now: new Date("2026-07-24T09:00:00Z"),
    });
    const state = new URL(started.authoriseUrl).searchParams.get("state");
    const redirectUri = new URL(started.authoriseUrl).searchParams.get("redirect_uri");
    assert.equal(redirectUri, "https://jefe.test/channels/slack/callback");

    await assert.rejects(
      () =>
        completeSlackConnection(prisma, {
          merchantId: second.merchant.id,
          shopId: second.shop.id,
          state,
          code: "code-1",
          env: channelEnv,
          adapter: slackAdapter,
          now: new Date("2026-07-24T09:01:00Z"),
        }),
      /Slack authorisation could not be verified/i,
    );

    const connection = await completeSlackConnection(prisma, {
      merchantId: first.merchant.id,
      shopId: first.shop.id,
      state,
      code: "code-1",
      env: channelEnv,
      adapter: slackAdapter,
      now: new Date("2026-07-24T09:01:00Z"),
    });
    assert.equal(connection.status, CHANNEL_STATUS.needsConfiguration);
    assert.equal(connection.verified, false);

    await assert.rejects(
      () =>
        completeSlackConnection(prisma, {
          merchantId: first.merchant.id,
          shopId: first.shop.id,
          state,
          code: "code-2",
          env: channelEnv,
          adapter: slackAdapter,
          now: new Date("2026-07-24T09:02:00Z"),
        }),
      /Slack authorisation could not be verified/i,
    );

    const expired = await startSlackConnection(prisma, {
      merchantId: first.merchant.id,
      shopId: first.shop.id,
      requestUrl: `https://jefe.test/app?shop=${first.shop.shopDomain}&host=test`,
      env: channelEnv,
      adapter: slackAdapter,
      now: new Date("2026-07-24T10:00:00Z"),
    });
    await assert.rejects(
      () =>
        completeSlackConnection(prisma, {
          merchantId: first.merchant.id,
          shopId: first.shop.id,
          state: new URL(expired.authoriseUrl).searchParams.get("state"),
          code: "code-3",
          env: channelEnv,
          adapter: slackAdapter,
          now: new Date("2026-07-24T10:11:00Z"),
        }),
      /Slack authorisation could not be verified/i,
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: `Channel Test ${suffix}` } },
    });
    await prisma.$disconnect();
  }
});

test("Slack credentials stay server-side and test messages use the selected destination", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for channel integration tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const slackAdapter = new MockSlackAdapter();

  try {
    const { merchant, shop } = await createChannelFixture(prisma, suffix, "slack");
    const started = await startSlackConnection(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      requestUrl: `https://jefe.test/app?shop=${shop.shopDomain}&host=test`,
      env: channelEnv,
      adapter: slackAdapter,
    });
    const completed = await completeSlackConnectionFromState(prisma, {
      state: new URL(started.authoriseUrl).searchParams.get("state"),
      code: "code",
      env: channelEnv,
      adapter: slackAdapter,
    });
    assert.equal(completed.returnPath, `/app?shop=${shop.shopDomain}&host=test&step=channels&channelProvider=slack`);

    const safeConnections = await listChannelConnections(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    assert.doesNotMatch(JSON.stringify(safeConnections), /xoxb-test-token/);
    const credential = await prisma.channelCredential.findFirstOrThrow({
      where: { merchantId: merchant.id, provider: "slack" },
    });
    assert.doesNotMatch(credential.encryptedPayload, /xoxb-test-token/);

    const destinations = await listSlackDestinations(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      env: channelEnv,
      adapter: slackAdapter,
    });
    assert.deepEqual(
      destinations.map((destination) => destination.label),
      ["#general", "#ops"],
    );
    const welcomed = await selectSlackDestinationAndSendWelcome(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      destinationId: "Cops",
      env: channelEnv,
      adapter: slackAdapter,
    });
    assert.equal(welcomed.status, CHANNEL_STATUS.connected);
    assert.equal(welcomed.verified, true);
    assert.equal(slackAdapter.sentMessages.length, 1);
    assert.equal(slackAdapter.sentMessages[0].channelId, "Cops");
    assert.equal(
      slackAdapter.sentMessages[0].message.body,
      "Jefe is connected. I\u2019ll send important updates here.",
    );
    const welcomeDelivery = await prisma.channelMessageDelivery.findFirstOrThrow({
      where: { merchantId: merchant.id, provider: "slack", category: "welcome" },
    });
    assert.equal(welcomeDelivery.status, "succeeded");

    const verified = await sendChannelTestMessage(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      provider: "slack",
      idempotencyKey: "slack-test-once",
      env: channelEnv,
      slackAdapter,
    });
    assert.equal(verified.status, CHANNEL_STATUS.connected);
    assert.equal(verified.verified, true);
    assert.equal(slackAdapter.sentMessages[1].channelId, "Cops");

    await sendChannelTestMessage(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      provider: "slack",
      idempotencyKey: "slack-test-once",
      env: channelEnv,
      slackAdapter,
    });
    assert.equal(slackAdapter.sentMessages.length, 2);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: `Channel Test ${suffix}` } },
    });
    await prisma.$disconnect();
  }
});

test("pending Slack authorisation state resets on the next Channels load", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for channel integration tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const slackAdapter = new MockSlackAdapter();

  try {
    const { merchant, shop } = await createChannelFixture(prisma, suffix, "slack-expired");
    await startSlackConnection(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      requestUrl: `https://jefe.test/app?shop=${shop.shopDomain}&host=test`,
      env: channelEnv,
      adapter: slackAdapter,
      now: new Date("2026-07-24T09:00:00Z"),
    });

    const reset = await resetPendingSlackAuthorisations(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      now: new Date("2026-07-24T09:01:00Z"),
    });
    assert.equal(reset.resetStates, 1);
    assert.equal(reset.resetConnections, 1);
    const slack = (
      await listChannelConnections(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
      })
    ).find((connection) => connection.provider === "slack");
    assert.equal(slack?.status, CHANNEL_STATUS.failed);
    assert.equal(slack?.safeErrorCode, "oauth_cancelled");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: `Channel Test ${suffix}` } },
    });
    await prisma.$disconnect();
  }
});

test("WhatsApp requires consent and does not connect until code verification succeeds", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for channel integration tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const whatsappAdapter = new MockWhatsAppAdapter();

  try {
    const { merchant, shop } = await createChannelFixture(prisma, suffix, "whatsapp");
    await assert.rejects(
      () =>
        startWhatsAppVerification(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          countryCode: "GB",
          phoneNumber: "07123 456789",
          consentAccepted: false,
          env: channelEnv,
          adapter: whatsappAdapter,
        }),
      /Confirm that Jefe can send operational WhatsApp messages/i,
    );

    await startWhatsAppVerification(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      countryCode: "GB",
      phoneNumber: "07123 456789",
      consentAccepted: true,
      env: channelEnv,
      adapter: whatsappAdapter,
      now: new Date("2026-07-24T09:00:00Z"),
    });
    const [safe] = await listChannelConnections(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    }).then((connections) => connections.filter((item) => item.provider === "whatsapp"));
    assert.equal(safe.status, CHANNEL_STATUS.verifying);
    assert.equal(safe.verified, false);
    assert.doesNotMatch(JSON.stringify(safe), /447123456789/);
    assert.match(safe.maskedDestination, /^\+44/);

    const challenge = await prisma.channelVerificationChallenge.findFirstOrThrow({
      where: { merchantId: merchant.id, provider: "whatsapp" },
    });
    assert.doesNotMatch(challenge.codeHash, new RegExp(whatsappAdapter.codes[0]));

    await assert.rejects(
      () =>
        confirmWhatsAppVerification(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          code: "000000",
          env: channelEnv,
          adapter: whatsappAdapter,
          now: new Date("2026-07-24T09:01:00Z"),
        }),
      /verification code is not right/i,
    );
    const verified = await confirmWhatsAppVerification(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      code: whatsappAdapter.codes[0],
      env: channelEnv,
      adapter: whatsappAdapter,
      now: new Date("2026-07-24T09:02:00Z"),
    });
    assert.equal(verified.status, CHANNEL_STATUS.connected);
    assert.equal(await hasVerifiedChannelConnection(prisma, { merchantId: merchant.id, shopId: shop.id }), true);
    assert.equal(whatsappAdapter.sentMessages.length, 1);
    assert.equal(
      whatsappAdapter.sentMessages[0].message.body,
      "Jefe is connected. I\u2019ll send important updates here.",
    );
    const welcomeDelivery = await prisma.channelMessageDelivery.findFirstOrThrow({
      where: { merchantId: merchant.id, provider: "whatsapp", category: "welcome" },
    });
    assert.equal(welcomeDelivery.status, "succeeded");
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: `Channel Test ${suffix}` } },
    });
    await prisma.$disconnect();
  }
});

test("WhatsApp verification codes expire and attempts are limited", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for channel integration tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();

  try {
    const { merchant, shop } = await createChannelFixture(prisma, suffix, "limits");
    const expiredAdapter = new MockWhatsAppAdapter();
    await startWhatsAppVerification(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      countryCode: "GB",
      phoneNumber: "07123 456789",
      consentAccepted: true,
      env: channelEnv,
      adapter: expiredAdapter,
      now: new Date("2026-07-24T09:00:00Z"),
    });
    await assert.rejects(
      () =>
        confirmWhatsAppVerification(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          code: expiredAdapter.codes[0],
          env: channelEnv,
          adapter: expiredAdapter,
          now: new Date("2026-07-24T09:11:00Z"),
        }),
      /verification code has expired/i,
    );

    await prisma.channelVerificationChallenge.deleteMany({
      where: { merchantId: merchant.id, provider: "whatsapp" },
    });
    const attemptsAdapter = new MockWhatsAppAdapter();
    await startWhatsAppVerification(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      countryCode: "GB",
      phoneNumber: "07123 456789",
      consentAccepted: true,
      env: channelEnv,
      adapter: attemptsAdapter,
      now: new Date("2026-07-24T09:20:00Z"),
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await assert.rejects(
        () =>
          confirmWhatsAppVerification(prisma, {
            merchantId: merchant.id,
            shopId: shop.id,
            code: "000000",
            env: channelEnv,
            adapter: attemptsAdapter,
            now: new Date("2026-07-24T09:21:00Z"),
          }),
        /verification code is not right/i,
      );
    }
    await assert.rejects(
      () =>
        confirmWhatsAppVerification(prisma, {
          merchantId: merchant.id,
          shopId: shop.id,
          code: "000000",
          env: channelEnv,
          adapter: attemptsAdapter,
          now: new Date("2026-07-24T09:22:00Z"),
        }),
      /Too many verification attempts/i,
    );
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: `Channel Test ${suffix}` } },
    });
    await prisma.$disconnect();
  }
});

test("disconnecting one provider does not remove the other provider", async (t) => {
  if (!databaseUrl) {
    t.skip("DATABASE_URL is required for channel integration tests");
    return;
  }

  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const suffix = uniqueSuffix();
  const whatsappAdapter = new MockWhatsAppAdapter();

  try {
    const { merchant, shop } = await createChannelFixture(prisma, suffix, "disconnect");
    await prisma.channelConnection.createMany({
      data: [
        {
          merchantId: merchant.id,
          shopId: shop.id,
          provider: "slack",
          status: CHANNEL_STATUS.connected,
          verifiedAt: new Date("2026-07-24T09:00:00Z"),
        },
        {
          merchantId: merchant.id,
          shopId: shop.id,
          provider: "whatsapp",
          status: CHANNEL_STATUS.connected,
          phoneE164: "+447123456789",
          maskedDestination: "+44 •••• ••• 6789",
          verificationStatus: "verified",
          verifiedAt: new Date("2026-07-24T09:00:00Z"),
        },
      ],
    });

    await disconnectChannelConnection(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      provider: "slack",
      env: channelEnv,
    });
    const connections = await listChannelConnections(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
    });
    assert.equal(
      connections.find((connection) => connection.provider === "slack").status,
      CHANNEL_STATUS.notConnected,
    );
    assert.equal(
      connections.find((connection) => connection.provider === "whatsapp").status,
      CHANNEL_STATUS.connected,
    );

    await sendChannelTestMessage(prisma, {
      merchantId: merchant.id,
      shopId: shop.id,
      provider: "whatsapp",
      idempotencyKey: "whatsapp-still-connected",
      env: channelEnv,
      whatsappAdapter,
    });
    assert.equal(whatsappAdapter.sentMessages.length, 1);
  } finally {
    await prisma.merchant.deleteMany({
      where: { name: { startsWith: `Channel Test ${suffix}` } },
    });
    await prisma.$disconnect();
  }
});

class MockSlackAdapter {
  constructor() {
    this.sentMessages = [];
    this.destinations = [
      { id: "Cgeneral", label: "#general", isPrivate: false, isMember: true },
      { id: "Cops", label: "#ops", isPrivate: true, isMember: true },
    ];
  }

  isConfigured() {
    return true;
  }

  getAuthorisationUrl(input) {
    const url = new URL("https://slack.test/oauth");
    url.searchParams.set("state", input.state);
    url.searchParams.set("redirect_uri", input.redirectUri);
    return url.toString();
  }

  async completeOAuth() {
    return {
      accessToken: "xoxb-test-token",
      botUserId: "B1",
      appId: "A1",
      teamId: "T1",
      teamName: "Very Long Test Workspace Name",
      scopes: ["chat:write", "channels:read"],
      rawSafeMetadata: { appId: "A1", botUserId: "B1" },
    };
  }

  async listDestinations() {
    return this.destinations;
  }

  async sendMessage(input) {
    this.sentMessages.push(input);
    return { providerMessageId: "123.456" };
  }

  async disconnect() {}
}

class MockWhatsAppAdapter {
  constructor() {
    this.codes = [];
    this.sentMessages = [];
  }

  providerName() {
    return "mock";
  }

  isConfigured() {
    return true;
  }

  async sendVerificationCode(input) {
    this.codes.push(input.code);
  }

  async sendMessage(input) {
    this.sentMessages.push(input);
    return { providerMessageId: "wamid.test" };
  }
}

async function createChannelFixture(prisma, suffix, label) {
  const merchant = await prisma.merchant.create({
    data: {
      name: `Channel Test ${suffix} ${label}`,
      shops: {
        create: {
          shopDomain: `channel-${label}-${suffix}.myshopify.com`,
          rawPayload: { source: "channel-test" },
        },
      },
    },
    include: { shops: true },
  });
  return { merchant, shop: merchant.shops[0] };
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
