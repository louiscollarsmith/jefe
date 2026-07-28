// @ts-check

import { verifySlackSignature } from "./slack-signature.server.js";

/**
 * Handle a raw inbound Slack Events API request.
 *
 * Slice 1: verifies the request signature, answers Slack's one-time
 * `url_verification` challenge, and acknowledges `message.im` DMs (logging
 * metadata only — never the message text). Slice 2 will route those DMs into
 * `sendConversationMessage` and reply. Returns a plain descriptor the thin route
 * turns into a `Response`, so this stays testable on plain `node --test`.
 *
 * @param {{
 *   signingSecret: string | undefined;
 *   signature: string | null;
 *   timestamp: string | null;
 *   rawBody: string;
 *   retryNum?: string | null;
 *   nowSeconds?: number;
 *   logger?: { info: (message: string, context?: Record<string, unknown>) => void };
 * }} input
 * @returns {{ status: number; body?: string; contentType?: string }}
 */
export function handleSlackEvent(input) {
  const valid = verifySlackSignature({
    signingSecret: input.signingSecret,
    signature: input.signature,
    timestamp: input.timestamp,
    rawBody: input.rawBody,
    nowSeconds: input.nowSeconds,
  });
  // Also covers "not configured yet" (no signing secret): we refuse rather than
  // trust unsigned traffic.
  if (!valid) return { status: 401 };

  let payload;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400 };
  }

  // Slack's endpoint verification: echo the challenge so the Request URL goes
  // green.
  if (payload?.type === "url_verification") {
    return {
      status: 200,
      body: String(payload.challenge ?? ""),
      contentType: "text/plain",
    };
  }

  if (payload?.type === "event_callback") {
    const event = payload.event ?? {};
    // Only a real merchant DM to Jefe: ignore the bot's own messages, edits,
    // joins, and non-DM channels.
    const isDirectMessage =
      event.type === "message" &&
      event.channel_type === "im" &&
      !event.bot_id &&
      !event.subtype;
    if (isDirectMessage && input.logger) {
      input.logger.info("slack inbound DM received", {
        teamId: payload.team_id,
        eventId: payload.event_id,
        retry: input.retryNum ?? null,
      });
    }
  }

  // Always ack fast with 200 so Slack does not retry.
  return { status: 200 };
}
