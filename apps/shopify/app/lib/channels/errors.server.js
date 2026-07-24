// @ts-check

const ERROR_MESSAGES = Object.freeze({
  app_not_present_private_channel:
    "I can only post to a private Slack channel after the Jefe app has been invited to it.",
  connection_not_found: "That channel connection could not be found.",
  destination_required: "Choose where Jefe should send the test message first.",
  duplicate_submission: "That request has already been handled.",
  invalid_number: "Enter a valid international mobile number.",
  invalid_oauth_state: "Slack authorisation could not be verified. Please try again.",
  invalid_verification_code: "That verification code is not right.",
  missing_consent:
    "Confirm that Jefe can send operational WhatsApp messages before verification.",
  no_available_destination:
    "No Slack destinations are available yet. For a private channel, invite the Jefe app to that channel first.",
  oauth_cancelled: "Slack authorisation was cancelled. Your other channel settings are unchanged.",
  provider_config_missing:
    "This channel is not ready in this environment because provider credentials are not configured.",
  provider_temporarily_unavailable:
    "The channel provider is temporarily unavailable. Please try again shortly.",
  required_permission_missing:
    "Slack did not grant the permissions Jefe needs to send updates.",
  test_message_failed:
    "The test message could not be sent. Check the destination and try again.",
  token_expired_or_revoked:
    "The saved Slack authorisation has expired or been revoked. Reconnect Slack to continue.",
  too_many_attempts: "Too many verification attempts. Request a new code.",
  too_many_requests: "Too many attempts in a short period. Please wait and try again.",
  unsupported_destination: "That destination is not supported for this channel.",
  verification_code_expired: "That verification code has expired. Request a new code.",
  workspace_installation_failed:
    "Slack installation did not complete. Please try authorising Slack again.",
});

export class ChannelServiceError extends Error {
  /**
   * @param {keyof typeof ERROR_MESSAGES | string} code
   * @param {string} [message]
   */
  constructor(code, message) {
    super(message ?? safeChannelErrorMessage(code));
    this.name = "ChannelServiceError";
    this.code = code;
  }
}

/** @param {string} code */
export function safeChannelErrorMessage(code) {
  return ERROR_MESSAGES[/** @type {keyof typeof ERROR_MESSAGES} */ (code)] ?? "That channel action could not be completed.";
}

/** @param {unknown} error @param {string} fallback */
export function normaliseProviderError(error, fallback = "provider_temporarily_unavailable") {
  if (error instanceof ChannelServiceError) return error;
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (/not_in_channel|channel_not_found/i.test(message)) {
    return new ChannelServiceError("app_not_present_private_channel");
  }
  if (/invalid_auth|not_authed|token_revoked|account_inactive/i.test(message)) {
    return new ChannelServiceError("token_expired_or_revoked");
  }
  if (/missing_scope|not_allowed_token_type/i.test(message)) {
    return new ChannelServiceError("required_permission_missing");
  }
  if (/rate.?limit|too many/i.test(message)) {
    return new ChannelServiceError("too_many_requests");
  }
  return new ChannelServiceError(fallback);
}
