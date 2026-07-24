// @ts-check

import {
  decryptChannelCredentialPayload,
  encryptChannelCredentialPayload,
  hashDestination,
  hashVerificationCode,
  randomStateToken,
  randomVerificationCode,
  sha256Hex,
  verifyVerificationCode,
} from "./crypto.server.js";
import { ChannelServiceError, safeChannelErrorMessage } from "./errors.server.js";
import { normalisePhoneToE164, maskPhoneNumber } from "./phone.server.js";
import { SlackChannelAdapter } from "./slack.server.js";
import { CHANNEL_STATUS } from "./status.js";
import { WhatsAppChannelAdapter } from "./whatsapp.server.js";

export const CHANNEL_PROVIDERS = Object.freeze(["slack", "whatsapp"]);
export { CHANNEL_STATUS } from "./status.js";
export const WHATSAPP_CONSENT_VERSION = "jefe_operational_whatsapp_v1";

const SLACK_STATE_TTL_MS = 10 * 60 * 1000;
const WHATSAPP_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const TEST_MESSAGE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function listChannelConnections(prisma, input) {
  const rows = await prisma.channelConnection.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: { in: [...CHANNEL_PROVIDERS] },
      disconnectedAt: null,
    },
    orderBy: { updatedAt: "desc" },
  });

  return CHANNEL_PROVIDERS.map((provider) => {
    const connection = rows.find((row) => row.provider === provider) ?? null;
    return serializeConnection(provider, connection);
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; now?: Date }} input
 */
export async function resetPendingSlackAuthorisations(prisma, input) {
  const now = input.now ?? new Date();
  const pending = await prisma.channelOAuthState.findMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: "slack",
      consumedAt: null,
    },
    select: { id: true },
  });
  if (pending.length === 0) return { resetStates: 0, resetConnections: 0 };

  await prisma.channelOAuthState.updateMany({
    where: {
      id: { in: pending.map((state) => state.id) },
      consumedAt: null,
    },
    data: { consumedAt: now },
  });

  const reset = await prisma.channelConnection.updateMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: "slack",
      status: CHANNEL_STATUS.authorising,
      credentialRef: null,
      disconnectedAt: null,
    },
    data: {
      status: CHANNEL_STATUS.failed,
      safeErrorCode: "oauth_cancelled",
      lastFailureAt: now,
    },
  });
  return { resetStates: pending.length, resetConnections: reset.count };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; requestUrl: string; env?: Record<string, string | undefined>; now?: Date; adapter?: SlackChannelAdapter }} input
 */
export async function startSlackConnection(prisma, input) {
  const adapter = input.adapter ?? new SlackChannelAdapter({ env: input.env });
  if (!adapter.isConfigured()) throw new ChannelServiceError("provider_config_missing");
  const now = input.now ?? new Date();
  const state = randomStateToken();
  const redirectUri = slackRedirectUri(input.requestUrl, input.env);
  const returnPath = slackReturnPath(input.requestUrl);

  await upsertConnection(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "slack",
    data: {
      status: CHANNEL_STATUS.authorising,
      safeErrorCode: null,
      disconnectedAt: null,
    },
  });

  await prisma.channelOAuthState.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: "slack",
      stateHash: sha256Hex(state),
      redirectUri,
      metadata: { source: "channels_onboarding", returnPath },
      expiresAt: new Date(now.getTime() + SLACK_STATE_TTL_MS),
    },
  });

  return { authoriseUrl: adapter.getAuthorisationUrl({ state, redirectUri }) };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; state: string | null; code?: string | null; error?: string | null; env?: Record<string, string | undefined>; now?: Date; adapter?: SlackChannelAdapter }} input
 */
export async function completeSlackConnection(prisma, input) {
  const now = input.now ?? new Date();
  const stateRow = await consumeOAuthState(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "slack",
    state: input.state,
    now,
  });

  return completeSlackConnectionForStateRow(prisma, stateRow, input, now);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ state: string | null; code?: string | null; error?: string | null; env?: Record<string, string | undefined>; now?: Date; adapter?: SlackChannelAdapter }} input
 */
export async function completeSlackConnectionFromState(prisma, input) {
  const now = input.now ?? new Date();
  const stateRow = await consumeOAuthStateWithoutTenant(prisma, {
    provider: "slack",
    state: input.state,
    now,
  });

  const connection = await completeSlackConnectionForStateRow(
    prisma,
    stateRow,
    input,
    now,
  );
  return {
    connection,
    returnPath: safeSlackReturnPath(stateRow.metadata),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ state: string | null }} input
 */
export async function getSlackReturnPathForState(prisma, input) {
  if (!input.state) return "/app?step=channels&channelProvider=slack";
  const state = await prisma.channelOAuthState.findFirst({
    where: {
      provider: "slack",
      stateHash: sha256Hex(input.state),
    },
  });
  return safeSlackReturnPath(state?.metadata);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string | null; redirectUri: string }} stateRow
 * @param {{ code?: string | null; error?: string | null; env?: Record<string, string | undefined>; adapter?: SlackChannelAdapter }} input
 * @param {Date} now
 */
async function completeSlackConnectionForStateRow(prisma, stateRow, input, now) {
  const shopId = stateRow.shopId ?? "";

  if (input.error) {
    await markConnectionFailure(prisma, {
      merchantId: stateRow.merchantId,
      shopId,
      provider: "slack",
      code: input.error === "access_denied" ? "oauth_cancelled" : "workspace_installation_failed",
      now,
    });
    throw new ChannelServiceError(input.error === "access_denied" ? "oauth_cancelled" : "workspace_installation_failed");
  }
  if (!input.code?.trim()) throw new ChannelServiceError("workspace_installation_failed");

  const adapter = input.adapter ?? new SlackChannelAdapter({ env: input.env });
  const installation = await adapter.completeOAuth({
    code: input.code.trim(),
    redirectUri: stateRow.redirectUri,
  });
  const connection = await upsertConnection(prisma, {
    merchantId: stateRow.merchantId,
    shopId,
    provider: "slack",
    data: {
      status: CHANNEL_STATUS.needsConfiguration,
      externalAccountId: installation.teamId,
      externalAccountName: installation.teamName,
      destinationId: null,
      destinationLabel: null,
      scopes: installation.scopes,
      capabilities: ["destinations", "test_messages", "operational_messages"],
      providerMetadata: installation.rawSafeMetadata,
      connectedAt: now,
      verifiedAt: null,
      lastValidationAt: now,
      lastFailureAt: null,
      safeErrorCode: null,
      disconnectedAt: null,
    },
  });
  const credential = await saveCredential(prisma, {
    merchantId: stateRow.merchantId,
    shopId,
    provider: "slack",
    connectionId: connection.id,
    payload: {
      accessToken: installation.accessToken,
      teamId: installation.teamId,
      teamName: installation.teamName,
      botUserId: installation.botUserId,
      appId: installation.appId,
    },
    env: input.env,
  });

  const updated = await prisma.channelConnection.update({
    where: { id: connection.id },
    data: { credentialRef: credential.id },
  });
  return serializeConnection("slack", updated);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; env?: Record<string, string | undefined>; adapter?: SlackChannelAdapter }} input
 */
export async function listSlackDestinations(prisma, input) {
  const connection = await requireConnection(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "slack",
  });
  const credential = await loadCredentialPayload(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "slack",
    credentialRef: connection.credentialRef,
    env: input.env,
  });
  const adapter = input.adapter ?? new SlackChannelAdapter({ env: input.env });
  const destinations = await adapter.listDestinations({
    accessToken: asString(credential.accessToken),
  });
  return destinations;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; destinationId: string; env?: Record<string, string | undefined>; adapter?: SlackChannelAdapter; now?: Date }} input
 */
export async function selectSlackDestination(prisma, input) {
  const destinations = await listSlackDestinations(prisma, input);
  const destination = destinations.find((item) => item.id === input.destinationId);
  if (!destination) throw new ChannelServiceError("unsupported_destination");
  if (destination.isPrivate && destination.isMember === false) {
    throw new ChannelServiceError("app_not_present_private_channel");
  }

  const connection = await requireConnection(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "slack",
  });
  const destinationChanged = connection.destinationId !== destination.id;
  const updated = await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      status: destinationChanged ? CHANNEL_STATUS.needsConfiguration : connection.status,
      destinationId: destination.id,
      destinationLabel: destination.label,
      verifiedAt: destinationChanged ? null : connection.verifiedAt,
      safeErrorCode: null,
      providerMetadata: {
        ...jsonObject(connection.providerMetadata),
        destinationIsPrivate: destination.isPrivate,
      },
    },
  });
  return serializeConnection("slack", updated);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; destinationId: string; env?: Record<string, string | undefined>; adapter?: SlackChannelAdapter; now?: Date }} input
 */
export async function selectSlackDestinationAndSendWelcome(prisma, input) {
  const selected = await selectSlackDestination(prisma, input);
  return sendChannelWelcomeMessage(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "slack",
    idempotencyKey: `channel-welcome:slack:${selected.id ?? "new"}:${selected.destinationId ?? input.destinationId}`,
    env: input.env,
    slackAdapter: input.adapter,
    now: input.now,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; countryCode?: string | null; phoneNumber: string; consentAccepted: boolean; env?: Record<string, string | undefined>; adapter?: WhatsAppChannelAdapter; now?: Date }} input
 */
export async function startWhatsAppVerification(prisma, input) {
  if (!input.consentAccepted) throw new ChannelServiceError("missing_consent");
  const adapter = input.adapter ?? new WhatsAppChannelAdapter({ env: input.env });
  if (!adapter.isConfigured()) throw new ChannelServiceError("provider_config_missing");
  const now = input.now ?? new Date();
  await enforceChallengeRateLimit(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "whatsapp",
    now,
  });

  const phoneE164 = normalisePhoneToE164({
    countryCode: input.countryCode,
    phoneNumber: input.phoneNumber,
  });
  const maskedDestination = maskPhoneNumber(phoneE164);
  const code = randomVerificationCode();
  const connection = await upsertConnection(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "whatsapp",
    data: {
      status: CHANNEL_STATUS.verifying,
      phoneE164,
      maskedDestination,
      verificationStatus: "pending",
      consentStatus: "accepted",
      consentedAt: now,
      consentVersion: WHATSAPP_CONSENT_VERSION,
      capabilities: ["test_messages", "operational_messages"],
      providerMetadata: { provider: adapter.providerName() },
      lastFailureAt: null,
      safeErrorCode: null,
      disconnectedAt: null,
    },
  });
  const challenge = await prisma.channelVerificationChallenge.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      connectionId: connection.id,
      provider: "whatsapp",
      destinationHash: hashDestination(phoneE164, input.env),
      destinationMasked: maskedDestination ?? "masked",
      codeHash: hashVerificationCode(code, phoneE164, input.env),
      expiresAt: new Date(now.getTime() + WHATSAPP_CHALLENGE_TTL_MS),
    },
  });

  try {
    await adapter.sendVerificationCode({ to: phoneE164, code });
  } catch (error) {
    await markConnectionFailure(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: "whatsapp",
      code: providerFailureCode(error),
      now,
    });
    throw error;
  }

  return {
    connection: serializeConnection("whatsapp", connection),
    expiresAt: challenge.expiresAt.toISOString(),
  };
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; code: string; env?: Record<string, string | undefined>; adapter?: WhatsAppChannelAdapter; now?: Date }} input
 */
export async function confirmWhatsAppVerification(prisma, input) {
  const now = input.now ?? new Date();
  const connection = await requireConnection(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "whatsapp",
  });
  if (!connection.phoneE164) throw new ChannelServiceError("invalid_number");
  const challenge = await prisma.channelVerificationChallenge.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: "whatsapp",
      connectionId: connection.id,
      consumedAt: null,
    },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge) throw new ChannelServiceError("verification_code_expired");
  if (challenge.expiresAt <= now) throw new ChannelServiceError("verification_code_expired");
  if (challenge.attempts >= challenge.maxAttempts) throw new ChannelServiceError("too_many_attempts");

  const nextAttempts = challenge.attempts + 1;
  await prisma.channelVerificationChallenge.update({
    where: { id: challenge.id },
    data: { attempts: nextAttempts },
  });

  const valid = verifyVerificationCode(
    input.code,
    connection.phoneE164,
    challenge.codeHash,
    input.env,
  );
  if (!valid) {
    if (nextAttempts >= challenge.maxAttempts) throw new ChannelServiceError("too_many_attempts");
    throw new ChannelServiceError("invalid_verification_code");
  }

  await prisma.channelVerificationChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: now },
  });
  await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      status: CHANNEL_STATUS.connected,
      verificationStatus: "verified",
      verifiedAt: now,
      connectedAt: connection.connectedAt ?? now,
      lastValidationAt: now,
      lastFailureAt: null,
      safeErrorCode: null,
    },
  });
  return sendChannelWelcomeMessage(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: "whatsapp",
    idempotencyKey: `channel-welcome:whatsapp:${connection.id}:${challenge.id}`,
    env: input.env,
    whatsappAdapter: input.adapter,
    now,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; idempotencyKey?: string | null; env?: Record<string, string | undefined>; slackAdapter?: SlackChannelAdapter; whatsappAdapter?: WhatsAppChannelAdapter; now?: Date; appUrl?: string | null }} input
 */
export async function sendChannelTestMessage(prisma, input) {
  return sendChannelMessage(prisma, input, {
    category: "test",
    message: testMessage(input.appUrl),
    enforceRateLimit: true,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; idempotencyKey?: string | null; env?: Record<string, string | undefined>; slackAdapter?: SlackChannelAdapter; whatsappAdapter?: WhatsAppChannelAdapter; now?: Date }} input
 */
export async function sendChannelWelcomeMessage(prisma, input) {
  return sendChannelMessage(prisma, input, {
    category: "welcome",
    message: welcomeMessage(),
    enforceRateLimit: false,
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; idempotencyKey?: string | null; env?: Record<string, string | undefined>; slackAdapter?: SlackChannelAdapter; whatsappAdapter?: WhatsAppChannelAdapter; now?: Date }} input
 * @param {{ category: string; message: ReturnType<typeof testMessage>; enforceRateLimit: boolean }} options
 */
async function sendChannelMessage(prisma, input, options) {
  if (!CHANNEL_PROVIDERS.includes(input.provider)) {
    throw new ChannelServiceError("unsupported_destination");
  }
  const now = input.now ?? new Date();
  const connection = await requireConnection(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: input.provider,
  });
  if (options.enforceRateLimit) {
    await enforceTestMessageRateLimit(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
      now,
    });
  }

  const idempotencyKey =
    input.idempotencyKey?.trim() ||
    `channel-${options.category}:${input.provider}:${connection.id}:${now.toISOString()}`;
  const existing = await prisma.channelMessageDelivery.findFirst({
    where: { merchantId: input.merchantId, idempotencyKey },
  });
  if (existing?.status === "succeeded") return serializeConnection(input.provider, connection);
  if (existing?.status === "pending") throw new ChannelServiceError("duplicate_submission");

  const delivery = await prisma.channelMessageDelivery.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      connectionId: connection.id,
      provider: input.provider,
      category: options.category,
      idempotencyKey,
      status: "pending",
      metadata: { source: "channels_onboarding" },
    },
  });

  try {
    const result =
      input.provider === "slack"
        ? await sendSlackMessage(prisma, connection, {
            env: input.env,
            adapter: input.slackAdapter,
            message: options.message,
          })
        : await sendWhatsAppMessage(connection, {
            env: input.env,
            adapter: input.whatsappAdapter,
            message: options.message,
          });

    await prisma.channelMessageDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "succeeded",
        providerMessageId: result.providerMessageId ?? null,
        sentAt: now,
      },
    });
    const updated = await prisma.channelConnection.update({
      where: { id: connection.id },
      data: {
        status: CHANNEL_STATUS.connected,
        verifiedAt: connection.verifiedAt ?? now,
        lastSuccessfulMessageAt: now,
        lastValidationAt: now,
        lastFailureAt: null,
        safeErrorCode: null,
      },
    });
    return serializeConnection(input.provider, updated);
  } catch (error) {
    const safeCode = providerFailureCode(error);
    await prisma.channelMessageDelivery.update({
      where: { id: delivery.id },
      data: { status: "failed", safeErrorCode: safeCode },
    });
    await prisma.channelConnection.update({
      where: { id: connection.id },
      data: {
        status:
          connection.status === CHANNEL_STATUS.connected
            ? CHANNEL_STATUS.degraded
            : CHANNEL_STATUS.failed,
        lastFailureAt: now,
        safeErrorCode: safeCode,
      },
    });
    throw error;
  }
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; env?: Record<string, string | undefined>; adapter?: SlackChannelAdapter; now?: Date }} input
 */
export async function disconnectChannelConnection(prisma, input) {
  if (!CHANNEL_PROVIDERS.includes(input.provider)) {
    throw new ChannelServiceError("unsupported_destination");
  }
  const now = input.now ?? new Date();
  const connection = await requireConnection(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: input.provider,
  });

  if (input.provider === "slack" && connection.credentialRef) {
    const payload = await loadCredentialPayload(prisma, {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: "slack",
      credentialRef: connection.credentialRef,
      env: input.env,
    }).catch(() => null);
    if (payload?.accessToken) {
      const adapter = input.adapter ?? new SlackChannelAdapter({ env: input.env });
      await adapter.disconnect({ accessToken: asString(payload.accessToken) });
    }
  }

  await prisma.channelCredential.deleteMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
      connectionId: connection.id,
    },
  });
  const updated = await prisma.channelConnection.update({
    where: { id: connection.id },
    data: {
      status: CHANNEL_STATUS.disconnected,
      credentialRef: null,
      disconnectedAt: now,
      safeErrorCode: null,
    },
  });
  return serializeConnection(input.provider, updated);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function hasVerifiedChannelConnection(prisma, input) {
  const count = await prisma.channelConnection.count({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: { in: [...CHANNEL_PROVIDERS] },
      status: CHANNEL_STATUS.connected,
      verifiedAt: { not: null },
      disconnectedAt: null,
    },
  });
  return count > 0;
}

/**
 * @param {unknown} error
 */
export function channelActionError(error) {
  const code = error instanceof ChannelServiceError ? error.code : "provider_temporarily_unavailable";
  return { code, message: safeChannelErrorMessage(code) };
}

/** @param {string} requestUrl @param {Record<string, string | undefined> | undefined} env */
export function slackRedirectUri(requestUrl, env = process.env) {
  const configured = env.SLACK_REDIRECT_URI?.trim();
  if (configured) return configured;
  const current = new URL(requestUrl);
  return new URL(
    "/channels/slack/callback",
    env.SHOPIFY_APP_URL?.trim() || current.origin,
  ).toString();
}

/** @param {string} requestUrl */
function slackReturnPath(requestUrl) {
  const current = new URL(requestUrl);
  const returnUrl = new URL("/app", current.origin);
  for (const key of ["shop", "host", "embedded"]) {
    const value = current.searchParams.get(key);
    if (value) returnUrl.searchParams.set(key, value);
  }
  returnUrl.searchParams.set("step", "channels");
  returnUrl.searchParams.set("channelProvider", "slack");
  return `${returnUrl.pathname}?${returnUrl.searchParams.toString()}`;
}

/** @param {unknown} metadata */
function safeSlackReturnPath(metadata) {
  const value =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? /** @type {{ returnPath?: unknown }} */ (metadata).returnPath
      : null;
  if (typeof value !== "string") return "/app?step=channels&channelProvider=slack";
  if (!value.startsWith("/app?") && value !== "/app") {
    return "/app?step=channels&channelProvider=slack";
  }
  return value;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; data: Record<string, unknown> }} input
 */
async function upsertConnection(prisma, input) {
  const existing = await prisma.channelConnection.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
      disconnectedAt: null,
    },
  });
  if (existing) {
    return prisma.channelConnection.update({
      where: { id: existing.id },
      data: input.data,
    });
  }
  return prisma.channelConnection.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
      ...input.data,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string }} input
 */
async function requireConnection(prisma, input) {
  const connection = await prisma.channelConnection.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
      disconnectedAt: null,
    },
  });
  if (!connection) throw new ChannelServiceError("connection_not_found");
  return connection;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; state: string | null; now: Date }} input
 */
async function consumeOAuthState(prisma, input) {
  if (!input.state) throw new ChannelServiceError("invalid_oauth_state");
  const state = await prisma.channelOAuthState.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
      stateHash: sha256Hex(input.state),
      consumedAt: null,
    },
  });
  if (!state || state.expiresAt <= input.now) throw new ChannelServiceError("invalid_oauth_state");
  const consumed = await prisma.channelOAuthState.updateMany({
    where: {
      id: state.id,
      consumedAt: null,
      expiresAt: { gt: input.now },
    },
    data: { consumedAt: input.now },
  });
  if (consumed.count !== 1) throw new ChannelServiceError("invalid_oauth_state");
  return state;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ provider: string; state: string | null; now: Date }} input
 */
async function consumeOAuthStateWithoutTenant(prisma, input) {
  if (!input.state) throw new ChannelServiceError("invalid_oauth_state");
  const state = await prisma.channelOAuthState.findFirst({
    where: {
      provider: input.provider,
      stateHash: sha256Hex(input.state),
      consumedAt: null,
    },
  });
  if (!state || state.expiresAt <= input.now) {
    throw new ChannelServiceError("invalid_oauth_state");
  }
  const consumed = await prisma.channelOAuthState.updateMany({
    where: {
      id: state.id,
      consumedAt: null,
      expiresAt: { gt: input.now },
    },
    data: { consumedAt: input.now },
  });
  if (consumed.count !== 1) throw new ChannelServiceError("invalid_oauth_state");
  return state;
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; connectionId: string; payload: unknown; env?: Record<string, string | undefined> }} input
 */
async function saveCredential(prisma, input) {
  return prisma.channelCredential.create({
    data: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
      connectionId: input.connectionId,
      encryptedPayload: encryptChannelCredentialPayload(input.payload, input.env),
      keyVersion: "v1",
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; credentialRef: string | null; env?: Record<string, string | undefined> }} input
 */
async function loadCredentialPayload(prisma, input) {
  if (!input.credentialRef) throw new ChannelServiceError("connection_not_found");
  const credential = await prisma.channelCredential.findFirst({
    where: {
      id: input.credentialRef,
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
    },
  });
  if (!credential) throw new ChannelServiceError("connection_not_found");
  return decryptChannelCredentialPayload(credential.encryptedPayload, input.env);
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {import("@prisma/client").ChannelConnection} connection
 * @param {{ env?: Record<string, string | undefined>; adapter?: SlackChannelAdapter; message: ReturnType<typeof testMessage> }} input
 */
async function sendSlackMessage(prisma, connection, input) {
  if (!connection.destinationId) throw new ChannelServiceError("destination_required");
  const payload = await loadCredentialPayload(prisma, {
    merchantId: connection.merchantId,
    shopId: connection.shopId ?? "",
    provider: "slack",
    credentialRef: connection.credentialRef,
    env: input.env,
  });
  const adapter = input.adapter ?? new SlackChannelAdapter({ env: input.env });
  return adapter.sendMessage({
    accessToken: asString(payload.accessToken),
    channelId: connection.destinationId,
    message: input.message,
  });
}

/**
 * @param {import("@prisma/client").ChannelConnection} connection
 * @param {{ env?: Record<string, string | undefined>; adapter?: WhatsAppChannelAdapter; message: ReturnType<typeof testMessage> }} input
 */
async function sendWhatsAppMessage(connection, input) {
  if (!connection.phoneE164 || connection.verificationStatus !== "verified") {
    throw new ChannelServiceError("connection_not_found");
  }
  const adapter = input.adapter ?? new WhatsAppChannelAdapter({ env: input.env });
  return adapter.sendMessage({ to: connection.phoneE164, message: input.message });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; now: Date }} input
 */
async function enforceChallengeRateLimit(prisma, input) {
  const count = await prisma.channelVerificationChallenge.count({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
      createdAt: { gt: new Date(input.now.getTime() - RATE_LIMIT_WINDOW_MS) },
    },
  });
  if (count >= 5) throw new ChannelServiceError("too_many_requests");
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; now: Date }} input
 */
async function enforceTestMessageRateLimit(prisma, input) {
  const count = await prisma.channelMessageDelivery.count({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: input.provider,
      category: "test",
      createdAt: { gt: new Date(input.now.getTime() - TEST_MESSAGE_RATE_LIMIT_WINDOW_MS) },
    },
  });
  if (count >= 5) throw new ChannelServiceError("too_many_requests");
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; provider: string; code: string; now: Date }} input
 */
async function markConnectionFailure(prisma, input) {
  await upsertConnection(prisma, {
    merchantId: input.merchantId,
    shopId: input.shopId,
    provider: input.provider,
    data: {
      status: CHANNEL_STATUS.failed,
      safeErrorCode: input.code,
      lastFailureAt: input.now,
      disconnectedAt: null,
    },
  });
}

/** @param {unknown} error */
function providerFailureCode(error) {
  return error instanceof ChannelServiceError
    ? error.code
    : "provider_temporarily_unavailable";
}

/** @param {string | null | undefined} appUrl */
function testMessage(appUrl) {
  return {
    title: "Jefe test message",
    body: "You are connected. I will use this channel when I find something worth your attention.",
    actionUrl: appUrl || null,
  };
}

function welcomeMessage() {
  return {
    title: "",
    body: "Jefe is connected. I\u2019ll send important updates here.",
    actionUrl: null,
  };
}

/** @param {string} provider @param {any | null} connection */
function serializeConnection(provider, connection) {
  if (!connection) {
    return {
      provider,
      status: CHANNEL_STATUS.notConnected,
      connected: false,
      verified: false,
      accountName: null,
      destinationId: null,
      destinationLabel: null,
      maskedDestination: null,
      safeErrorCode: null,
      errorMessage: null,
      connectedAt: null,
      verifiedAt: null,
      lastSuccessfulMessageAt: null,
      consentStatus: null,
      consentVersion: null,
      capabilities: [],
    };
  }

  const verified = Boolean(
    connection.status === CHANNEL_STATUS.connected &&
      connection.verifiedAt &&
      !connection.disconnectedAt,
  );
  return {
    id: connection.id,
    provider,
    status: connection.disconnectedAt ? CHANNEL_STATUS.disconnected : connection.status,
    connected: verified,
    verified,
    accountName: connection.externalAccountName ?? null,
    destinationId: connection.destinationId ?? null,
    destinationLabel: connection.destinationLabel ?? null,
    maskedDestination: connection.maskedDestination ?? null,
    safeErrorCode: connection.safeErrorCode ?? null,
    errorMessage: connection.safeErrorCode
      ? safeChannelErrorMessage(connection.safeErrorCode)
      : null,
    connectedAt: connection.connectedAt?.toISOString() ?? null,
    verifiedAt: connection.verifiedAt?.toISOString() ?? null,
    lastSuccessfulMessageAt: connection.lastSuccessfulMessageAt?.toISOString() ?? null,
    consentStatus: connection.consentStatus ?? null,
    consentVersion: connection.consentVersion ?? null,
    capabilities: Array.isArray(connection.capabilities) ? connection.capabilities : [],
  };
}

/** @param {unknown} value */
function asString(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChannelServiceError("connection_not_found");
  }
  return value;
}

/** @param {unknown} value */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}
