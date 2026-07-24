// @ts-check

import { ChannelServiceError, normaliseProviderError } from "./errors.server.js";

const META_GRAPH_VERSION = "v25.0";

export class WhatsAppChannelAdapter {
  /**
   * @param {{ env?: Record<string, string | undefined>; fetchImpl?: typeof fetch }} [options]
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  providerName() {
    const configured = this.env.WHATSAPP_PROVIDER?.trim().toLowerCase();
    if (configured) return configured;
    if (this.hasMetaConfig()) return "meta";
    return "unconfigured";
  }

  isConfigured() {
    const provider = this.providerName();
    if (provider === "meta") return this.hasMetaConfig();
    return false;
  }

  /** @param {{ to: string; code: string }} input */
  async sendVerificationCode(input) {
    const body = `Your Jefe verification code is ${input.code}.`;
    if (this.providerName() === "meta") {
      await this.sendMetaMessage({
        to: input.to,
        body,
        templateName: this.env.META_WHATSAPP_VERIFICATION_TEMPLATE_NAME,
        templateParameters: [input.code],
        requireTemplate: true,
      });
      return;
    }
    await this.sendTextMessage({ to: input.to, body });
  }

  /** @param {{ to: string; message: { title?: string | null; body: string; actionUrl?: string | null } }} input */
  async sendMessage(input) {
    const body = [input.message.title, input.message.body, input.message.actionUrl]
      .filter(Boolean)
      .join("\n\n");
    await this.sendTextMessage({ to: input.to, body });
    return { providerMessageId: null };
  }

  /** @param {{ to: string; body: string }} input */
  async sendTextMessage(input) {
    const provider = this.providerName();
    if (provider === "meta") {
      return this.sendMetaMessage({
        to: input.to,
        body: input.body,
        templateName: this.env.META_WHATSAPP_MESSAGE_TEMPLATE_NAME,
        templateParameters: [input.body],
        requireTemplate: false,
      });
    }
    throw new ChannelServiceError("provider_config_missing");
  }

  hasMetaConfig() {
    return Boolean(
      this.env.META_WHATSAPP_ACCESS_TOKEN?.trim() &&
      this.env.META_WHATSAPP_PHONE_NUMBER_ID?.trim(),
    );
  }

  /**
   * @param {{ to: string; body: string; templateName?: string | null; templateParameters?: string[]; requireTemplate?: boolean }} input
   */
  async sendMetaMessage(input) {
    if (!this.hasMetaConfig()) throw new ChannelServiceError("provider_config_missing");
    const templateName = input.templateName?.trim();
    if (input.requireTemplate && !templateName) {
      throw new ChannelServiceError("provider_config_missing");
    }

    const phoneNumberId = this.env.META_WHATSAPP_PHONE_NUMBER_ID ?? "";
    const graphVersion = this.env.META_WHATSAPP_GRAPH_VERSION?.trim() || META_GRAPH_VERSION;
    const payload = templateName
      ? metaTemplatePayload(input.to, templateName, input.templateParameters ?? [])
      : {
          messaging_product: "whatsapp",
          to: input.to.replace(/[^\d]/g, ""),
          type: "text",
          text: { preview_url: false, body: input.body },
        };
    const response = await this.fetchImpl(
      `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(phoneNumberId)}/messages`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.env.META_WHATSAPP_ACCESS_TOKEN ?? ""}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );
    const body = await safeJson(response);
    if (!response.ok || body?.error) {
      throw normaliseProviderError(new Error(String(body?.error?.code ?? response.status)), "provider_temporarily_unavailable");
    }
    const providerMessageId =
      Array.isArray(body?.messages) && typeof body.messages[0]?.id === "string"
        ? body.messages[0].id
        : null;
    return { providerMessageId };
  }
}

/** @param {string} to @param {string} templateName @param {string[]} parameters */
function metaTemplatePayload(to, templateName, parameters) {
  return {
    messaging_product: "whatsapp",
    to: to.replace(/[^\d]/g, ""),
    type: "template",
    template: {
      name: templateName,
      language: { code: "en" },
      components:
        parameters.length > 0
          ? [
              {
                type: "body",
                parameters: parameters.map((text) => ({ type: "text", text })),
              },
            ]
          : [],
    },
  };
}

/** @param {Response} response */
async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
