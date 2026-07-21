// @ts-check

import crypto from "node:crypto";

export const KLAVIYO_CREDENTIAL_PROVIDER = "klaviyo";
export const KLAVIYO_REQUIRED_DRAFT_SCOPES = Object.freeze([
  "lists:read",
  "lists:write",
  "profiles:read",
  "profiles:write",
  "campaigns:read",
  "campaigns:write",
  "templates:read",
  "templates:write",
]);

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string; privateKey: string; now?: Date; env?: Record<string, string | undefined> }} input
 */
export async function saveKlaviyoPrivateKey(prisma, input) {
  const privateKey = input.privateKey.trim();
  if (privateKey.length < 12) {
    throw new Error("Klaviyo private key looks too short.");
  }

  const now = input.now ?? new Date();
  const encryptedPrivateKey = encryptSecret(privateKey, input.env ?? process.env);

  return prisma.merchantKlaviyoCredential.upsert({
    where: {
      shopId_provider: {
        shopId: input.shopId,
        provider: KLAVIYO_CREDENTIAL_PROVIDER,
      },
    },
    create: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: KLAVIYO_CREDENTIAL_PROVIDER,
      encryptedPrivateKey,
      keyPrefix: privateKey.slice(0, 7),
      lastFour: privateKey.slice(-4),
      scopesJson: [...KLAVIYO_REQUIRED_DRAFT_SCOPES],
      connectionStatus: "active",
      lastCheckedAt: now,
      lastError: null,
    },
    update: {
      merchantId: input.merchantId,
      encryptedPrivateKey,
      keyPrefix: privateKey.slice(0, 7),
      lastFour: privateKey.slice(-4),
      scopesJson: [...KLAVIYO_REQUIRED_DRAFT_SCOPES],
      connectionStatus: "active",
      lastCheckedAt: now,
      lastError: null,
    },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function loadKlaviyoCredential(prisma, input) {
  return prisma.merchantKlaviyoCredential.findFirst({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: KLAVIYO_CREDENTIAL_PROVIDER,
      connectionStatus: "active",
    },
    orderBy: { updatedAt: "desc" },
  });
}

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {{ merchantId: string; shopId: string }} input
 */
export async function removeKlaviyoCredential(prisma, input) {
  return prisma.merchantKlaviyoCredential.updateMany({
    where: {
      merchantId: input.merchantId,
      shopId: input.shopId,
      provider: KLAVIYO_CREDENTIAL_PROVIDER,
    },
    data: {
      connectionStatus: "removed",
      encryptedPrivateKey: "removed",
      lastError: null,
    },
  });
}

/**
 * @param {import("@prisma/client").MerchantKlaviyoCredential | null} credential
 * @param {Record<string, string | undefined>} [env]
 */
export function decryptKlaviyoPrivateKey(credential, env = process.env) {
  if (!credential || credential.connectionStatus !== "active") {
    throw new KlaviyoCredentialError("missing_secret");
  }

  return decryptSecret(credential.encryptedPrivateKey, env);
}

/**
 * @param {import("@prisma/client").MerchantKlaviyoCredential | null} credential
 */
export function serializeKlaviyoCredential(credential) {
  if (!credential || credential.connectionStatus !== "active") {
    return {
      status: "missing",
      maskedKey: null,
      lastCheckedAt: null,
      secretStoredInDb: false,
    };
  }

  return {
    id: credential.id,
    status: credential.connectionStatus,
    maskedKey: maskKeyParts(credential.keyPrefix, credential.lastFour),
    lastCheckedAt: credential.lastCheckedAt?.toISOString() ?? null,
    secretStoredInDb: true,
    scopes: Array.isArray(credential.scopesJson) ? credential.scopesJson : [],
  };
}

export class KlaviyoCredentialError extends Error {
  /** @param {"missing_secret" | "missing_encryption_secret" | "invalid_encrypted_secret"} reason */
  constructor(reason) {
    super(credentialErrorMessage(reason));
    this.name = "KlaviyoCredentialError";
    this.reason = reason;
  }
}

/** @param {string | null | undefined} prefix @param {string | null | undefined} lastFour */
function maskKeyParts(prefix, lastFour) {
  if (!prefix && !lastFour) return "masked";
  return `${prefix ?? ""}${"*".repeat(8)}${lastFour ?? ""}`;
}

/** @param {string} value @param {Record<string, string | undefined>} env */
function encryptSecret(value, env) {
  const key = encryptionKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(":");
}

/** @param {string} value @param {Record<string, string | undefined>} env */
function decryptSecret(value, env) {
  const [version, encodedIv, encodedTag, encodedEncrypted] = value.split(":");
  if (
    version !== "v1" ||
    !encodedIv ||
    !encodedTag ||
    !encodedEncrypted
  ) {
    throw new KlaviyoCredentialError("invalid_encrypted_secret");
  }

  try {
    const key = encryptionKey(env);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(encodedEncrypted, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof KlaviyoCredentialError) throw error;
    throw new KlaviyoCredentialError("invalid_encrypted_secret");
  }
}

/** @param {Record<string, string | undefined>} env */
function encryptionKey(env) {
  const secret = env.KLAVIYO_KEY_ENCRYPTION_SECRET;
  if (!secret || secret.trim().length < 16) {
    throw new KlaviyoCredentialError("missing_encryption_secret");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

/** @param {"missing_secret" | "missing_encryption_secret" | "invalid_encrypted_secret"} reason */
function credentialErrorMessage(reason) {
  if (reason === "missing_encryption_secret") {
    return "Klaviyo draft creation is blocked because KLAVIYO_KEY_ENCRYPTION_SECRET is not configured.";
  }
  if (reason === "invalid_encrypted_secret") {
    return "Klaviyo draft creation is blocked because the saved private key cannot be decrypted.";
  }
  return "Klaviyo draft creation is blocked because no usable private key is saved.";
}
