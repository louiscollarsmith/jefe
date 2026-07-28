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
 *   nowSeconds?: number;
 * }} input
 * @returns {{ status: number; body?: string; contentType?: string; inboundDm?: { teamId: string | null; channelId: string | null; userId: string | null; text: string; eventId: string | null } }}
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
    // Only a real merchant DM to Jefe with text: ignore the bot's own messages,
    // edits/joins (subtype), and non-DM channels. The route dispatches the
    // returned inboundDm to the async processor and still acks 200 immediately.
    const isDirectMessage =
      event.type === "message" &&
      event.channel_type === "im" &&
      !event.bot_id &&
      !event.subtype &&
      typeof event.text === "string" &&
      event.text.trim().length > 0;
    if (isDirectMessage) {
      return {
        status: 200,
        inboundDm: {
          teamId: typeof payload.team_id === "string" ? payload.team_id : null,
          channelId: typeof event.channel === "string" ? event.channel : null,
          userId: typeof event.user === "string" ? event.user : null,
          text: event.text,
          eventId: typeof payload.event_id === "string" ? payload.event_id : null,
        },
      };
    }
  }

  // Always ack fast with 200 so Slack does not retry.
  return { status: 200 };
}
