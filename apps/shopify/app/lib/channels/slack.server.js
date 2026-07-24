// @ts-check

import crypto from "node:crypto";

import { ChannelServiceError, normaliseProviderError } from "./errors.server.js";

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_API_URL = "https://slack.com/api";
const DEFAULT_SLACK_SCOPES = Object.freeze([
  "chat:write",
  "chat:write.public",
  "channels:read",
  "groups:read",
]);

export class SlackChannelAdapter {
  /**
   * @param {{ env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }} [options]
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  isConfigured() {
    return Boolean(this.env.SLACK_CLIENT_ID?.trim() && this.env.SLACK_CLIENT_SECRET?.trim());
  }

  /** @param {{ state: string; redirectUri: string }} input */
  getAuthorisationUrl(input) {
    if (!this.isConfigured()) throw new ChannelServiceError("provider_config_missing");
    const url = new URL(SLACK_AUTHORIZE_URL);
    url.searchParams.set("client_id", this.env.SLACK_CLIENT_ID ?? "");
    url.searchParams.set("scope", slackScopes(this.env).join(","));
    url.searchParams.set("state", input.state);
    url.searchParams.set("redirect_uri", input.redirectUri);
    return url.toString();
  }

  /** @param {{ code: string; redirectUri: string }} input */
  async completeOAuth(input) {
    if (!this.isConfigured()) throw new ChannelServiceError("provider_config_missing");
    const body = new URLSearchParams({
      client_id: this.env.SLACK_CLIENT_ID ?? "",
      client_secret: this.env.SLACK_CLIENT_SECRET ?? "",
      code: input.code,
      redirect_uri: input.redirectUri,
    });
    const response = await this.fetchImpl(`${SLACK_API_URL}/oauth.v2.access`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const payload = await safeJson(response);
    if (!response.ok || !payload?.ok) {
      throw normaliseProviderError(new Error(String(payload?.error ?? response.status)), "workspace_installation_failed");
    }

    const accessToken = stringOrNull(payload.access_token);
    const teamId = stringOrNull(payload.team?.id);
    if (!accessToken || !teamId) {
      throw new ChannelServiceError("workspace_installation_failed");
    }

    const validation = await this.validateInstallation({ accessToken });
    return {
      accessToken,
      botUserId: stringOrNull(payload.bot_user_id),
      appId: stringOrNull(payload.app_id),
      teamId,
      teamName: stringOrNull(payload.team?.name) ?? validation.teamName,
      scopes: parseScopeList(stringOrNull(payload.scope)),
      rawSafeMetadata: {
        appId: stringOrNull(payload.app_id),
        botUserId: stringOrNull(payload.bot_user_id),
        enterpriseId: stringOrNull(payload.enterprise?.id),
      },
    };
  }

  /** @param {{ accessToken: string }} input */
  async validateInstallation(input) {
    const payload = await slackPostForm(this.fetchImpl, "auth.test", input.accessToken);
    return {
      ok: true,
      teamId: stringOrNull(payload.team_id),
      teamName: stringOrNull(payload.team),
      userId: stringOrNull(payload.user_id),
      botId: stringOrNull(payload.bot_id),
    };
  }

  /** @param {{ accessToken: string }} input */
  async listDestinations(input) {
    /** @type {Array<{ id: string; label: string; isPrivate: boolean; isMember: boolean | null }>} */
    const destinations = [];
    let cursor = "";

    for (let page = 0; page < 5; page += 1) {
      const url = new URL(`${SLACK_API_URL}/conversations.list`);
      url.searchParams.set("limit", "200");
      url.searchParams.set("exclude_archived", "true");
      url.searchParams.set("types", "public_channel,private_channel");
      if (cursor) url.searchParams.set("cursor", cursor);

      const response = await this.fetchImpl(url.toString(), {
        headers: { authorization: `Bearer ${input.accessToken}` },
      });
      const payload = await safeJson(response);
      if (!response.ok || !payload?.ok) {
        throw normaliseProviderError(new Error(String(payload?.error ?? response.status)));
      }

      const channels = Array.isArray(payload.channels) ? payload.channels : [];
      for (const channel of channels) {
        const id = stringOrNull(channel.id);
        const name = stringOrNull(channel.name);
        if (!id || !name || channel.is_archived) continue;
        destinations.push({
          id,
          label: `#${name}`,
          isPrivate: Boolean(channel.is_private),
          isMember: typeof channel.is_member === "boolean" ? channel.is_member : null,
        });
      }

      cursor = stringOrNull(payload.response_metadata?.next_cursor) ?? "";
      if (!cursor) break;
    }

    return destinations;
  }

  /**
   * @param {{ accessToken: string; channelId: string; message: { title?: string | null; body: string; actionUrl?: string | null } }} input
   */
  async sendMessage(input) {
    const text = [input.message.title, input.message.body, input.message.actionUrl]
      .filter(Boolean)
      .join("\n\n");
    const blocks = [
      input.message.title
        ? {
            type: "section",
            text: { type: "mrkdwn", text: `*${escapeSlackText(input.message.title)}*` },
          }
        : null,
      {
        type: "section",
        text: { type: "mrkdwn", text: escapeSlackText(input.message.body) },
      },
      input.message.actionUrl
        ? {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Open Jefe" },
                url: input.message.actionUrl,
              },
            ],
          }
        : null,
    ].filter(Boolean);

    const response = await this.fetchImpl(`${SLACK_API_URL}/chat.postMessage`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json;charset=utf-8",
      },
      body: JSON.stringify({
        channel: input.channelId,
        text,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    const payload = await safeJson(response);
    if (!response.ok || !payload?.ok) {
      throw normaliseProviderError(new Error(String(payload?.error ?? response.status)), "test_message_failed");
    }
    return { providerMessageId: stringOrNull(payload.ts) };
  }

  /** @param {{ accessToken: string }} input */
  async disconnect(input) {
    try {
      await slackPostForm(this.fetchImpl, "auth.revoke", input.accessToken, {
        token: input.accessToken,
      });
    } catch {
      // Disconnecting locally must still invalidate the saved token.
    }
  }
}

/**
 * @param {string} rawBody
 * @param {string | null | undefined} timestamp
 * @param {string | null | undefined} signature
 * @param {string | null | undefined} signingSecret
 */
export function verifySlackRequestSignature(rawBody, timestamp, signature, signingSecret) {
  if (!rawBody || !timestamp || !signature || !signingSecret) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  return safeEqual(expected, signature);
}

/** @param {Record<string, string | undefined>} env */
function slackScopes(env) {
  const configured = env.SLACK_OAUTH_SCOPES?.split(",").map((scope) => scope.trim()).filter(Boolean);
  return configured?.length ? configured : [...DEFAULT_SLACK_SCOPES];
}

/**
 * @param {typeof fetch} fetchImpl
 * @param {string} method
 * @param {string} token
 * @param {Record<string, string>} [params]
 */
async function slackPostForm(fetchImpl, method, token, params = {}) {
  const response = await fetchImpl(`${SLACK_API_URL}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const payload = await safeJson(response);
  if (!response.ok || !payload?.ok) {
    throw normaliseProviderError(new Error(String(payload?.error ?? response.status)));
  }
  return payload;
}

/** @param {Response} response */
async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** @param {unknown} value */
function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @param {string | null} scopes */
function parseScopeList(scopes) {
  return scopes ? scopes.split(",").map((scope) => scope.trim()).filter(Boolean) : [];
}

/** @param {string} value */
function escapeSlackText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** @param {string} actual @param {string} expected */
function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
