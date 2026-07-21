// @ts-check

const KLAVIYO_API_BASE_URL = "https://a.klaviyo.com";
const KLAVIYO_REVISION = "2026-07-15";
const LIST_PROFILE_BATCH_SIZE = 1000;

/**
 * @param {{
 *   privateKey: string;
 *   shopId: string;
 *   actionId: string;
 *   idempotencyKey: string;
 *   now?: Date;
 *   campaignName: string;
 *   listName: string;
 *   templateName: string;
 *   subjectLine: string;
 *   previewText: string;
 *   html: string;
 *   text: string;
 *   treatmentCustomers: Array<{ email: string; emailHash: string; customerExternalId?: string | null }>;
 *   holdoutCount: number;
 *   existing?: Partial<Record<"list" | "campaign" | "campaignMessage" | "template", { id: string; name?: string | null }>>;
 *   fetchFn?: typeof fetch;
 * }} input
 */
export async function createKlaviyoWinbackDraft(input) {
  if (!input.privateKey) {
    throw new KlaviyoApiError({
      code: "missing_secret",
      message: "Missing Klaviyo private key.",
      retryable: false,
      step: "credential",
    });
  }
  if (input.treatmentCustomers.length === 0) {
    throw new KlaviyoApiError({
      code: "empty_treatment_audience",
      message: "No treatment customers are available for the Klaviyo draft.",
      retryable: false,
      step: "audience",
    });
  }

  const client = new KlaviyoClient({
    privateKey: input.privateKey,
    fetchFn: input.fetchFn,
  });
  const now = input.now ?? new Date();
  const artifacts = [];
  let profilesCreatedOrUpdated = 0;
  let profilesAddedToList = 0;
  let profilesFailed = 0;

  const profileIds = [];
  for (const customer of input.treatmentCustomers) {
    try {
      const profile = await client.upsertProfile({
        email: customer.email,
        externalId: customer.customerExternalId ?? undefined,
        properties: {
          jefe_shop_id: input.shopId,
          jefe_action_id: input.actionId,
          jefe_audience: "winback_treatment",
          jefe_created_at: now.toISOString(),
        },
      });
      profileIds.push(profile.id);
      profilesCreatedOrUpdated += 1;
      artifacts.push({
        artifactType: "klaviyo_profile",
        externalId: profile.id,
        externalName: null,
        externalStatus: "created_or_updated",
        payloadSnapshotJson: {
          emailHash: customer.emailHash,
          actionId: input.actionId,
        },
      });
    } catch (error) {
      profilesFailed += 1;
      if (error instanceof KlaviyoApiError && !error.retryable) {
        throw error.withStep("profile_create_failed");
      }
      throw normalizeKlaviyoError(error, "profile_create_failed");
    }
  }

  const list = input.existing?.list?.id
    ? { id: input.existing.list.id, name: input.existing.list.name ?? input.listName }
    : await client.createList(input.listName);
  artifacts.push({
    artifactType: "klaviyo_list",
    externalId: list.id,
    externalName: list.name,
    externalStatus: "draft_created",
    payloadSnapshotJson: { idempotencyKey: input.idempotencyKey },
  });

  for (const batch of chunks(profileIds, LIST_PROFILE_BATCH_SIZE)) {
    await client.addProfilesToList(list.id, batch);
    profilesAddedToList += batch.length;
  }

  const campaign = input.existing?.campaign?.id
    ? {
        id: input.existing.campaign.id,
        name: input.existing.campaign.name ?? input.campaignName,
        messageId: input.existing.campaignMessage?.id ?? null,
      }
    : await client.createCampaign({
        name: input.campaignName,
        listId: list.id,
        subjectLine: input.subjectLine,
        previewText: input.previewText,
      });
  artifacts.push({
    artifactType: "klaviyo_campaign",
    externalId: campaign.id,
    externalName: campaign.name,
    externalStatus: "draft_created",
    payloadSnapshotJson: {
      audience: "treatment_list_only",
      sendEnabled: false,
    },
  });

  const template = input.existing?.template?.id
    ? {
        id: input.existing.template.id,
        name: input.existing.template.name ?? input.templateName,
      }
    : await client.createTemplate({
        name: input.templateName,
        html: input.html,
        text: input.text,
      });
  artifacts.push({
    artifactType: "klaviyo_template",
    externalId: template.id,
    externalName: template.name,
    externalStatus: "draft_created",
    payloadSnapshotJson: { editorType: "CODE" },
  });

  const messageId = campaign.messageId;
  if (!messageId) {
    throw new KlaviyoApiError({
      code: "klaviyo_validation_error",
      message: "Klaviyo campaign response did not include a campaign message ID.",
      retryable: false,
      step: "campaign_create_failed",
    });
  }

  artifacts.push({
    artifactType: "klaviyo_campaign_message",
    externalId: messageId,
    externalName: input.subjectLine,
    externalStatus: "draft_created",
    payloadSnapshotJson: { campaignId: campaign.id },
  });

  await client.assignTemplateToCampaignMessage({
    messageId,
    templateId: template.id,
  });

  return {
    connector: "klaviyo",
    dryRun: false,
    actionId: input.actionId,
    idempotencyKey: input.idempotencyKey,
    externalDraftId: campaign.id,
    campaignName: campaign.name,
    klaviyoListId: list.id,
    klaviyoCampaignId: campaign.id,
    klaviyoCampaignMessageId: messageId,
    klaviyoTemplateId: template.id,
    externalStatus: "draft_created",
    executionMode: "draft_only",
    sendEnabled: false,
    audience: {
      treatmentCount: input.treatmentCustomers.length,
      holdoutCount: input.holdoutCount,
    },
    profilesCreatedOrUpdated,
    profilesAddedToList,
    profilesFailed,
    artifacts,
  };
}

class KlaviyoClient {
  /** @param {{ privateKey: string; fetchFn?: typeof fetch }} input */
  constructor(input) {
    this.privateKey = input.privateKey;
    this.fetchFn = input.fetchFn ?? fetch;
  }

  /** @param {{ email: string; externalId?: string; properties: Record<string, unknown> }} input */
  async upsertProfile(input) {
    const response = await this.request("/api/profile-import", {
      method: "POST",
      step: "profile_create_failed",
      body: {
        data: {
          type: "profile",
          attributes: {
            email: input.email,
            ...(input.externalId ? { external_id: input.externalId } : {}),
            properties: input.properties,
          },
        },
      },
    });

    return {
      id: requiredId(response, "profile_create_failed"),
    };
  }

  /** @param {string} name */
  async createList(name) {
    const response = await this.request("/api/lists", {
      method: "POST",
      step: "list_create_failed",
      body: {
        data: {
          type: "list",
          attributes: { name },
        },
      },
    });

    return {
      id: requiredId(response, "list_create_failed"),
      name: response.data?.attributes?.name ?? name,
    };
  }

  /** @param {string} listId @param {string[]} profileIds */
  async addProfilesToList(listId, profileIds) {
    await this.request(`/api/lists/${encodeURIComponent(listId)}/relationships/profiles`, {
      method: "POST",
      step: "list_profile_add_failed",
      body: {
        data: profileIds.map((id) => ({ type: "profile", id })),
      },
      allowNoContent: true,
    });
  }

  /** @param {{ name: string; html: string; text: string }} input */
  async createTemplate(input) {
    const response = await this.request("/api/templates", {
      method: "POST",
      step: "template_create_failed",
      body: {
        data: {
          type: "template",
          attributes: {
            name: input.name,
            editor_type: "CODE",
            html: input.html,
            text: input.text,
          },
        },
      },
    });

    return {
      id: requiredId(response, "template_create_failed"),
      name: response.data?.attributes?.name ?? input.name,
    };
  }

  /** @param {{ name: string; listId: string; subjectLine: string; previewText: string }} input */
  async createCampaign(input) {
    const response = await this.request("/api/campaigns", {
      method: "POST",
      step: "campaign_create_failed",
      body: {
        data: {
          type: "campaign",
          attributes: {
            name: input.name,
            audiences: {
              included: [input.listId],
              excluded: [],
            },
            "campaign-messages": {
              data: [
                {
                  type: "campaign-message",
                  attributes: {
                    definition: {
                      channel: "email",
                      label: input.name,
                      content: {
                        subject: input.subjectLine,
                        preview_text: input.previewText,
                      },
                    },
                  },
                },
              ],
            },
          },
        },
      },
    });

    return {
      id: requiredId(response, "campaign_create_failed"),
      name: response.data?.attributes?.name ?? input.name,
      messageId: campaignMessageId(response),
    };
  }

  /** @param {{ messageId: string; templateId: string }} input */
  async assignTemplateToCampaignMessage(input) {
    await this.request("/api/campaign-message-assign-template", {
      method: "POST",
      step: "template_assign_failed",
      body: {
        data: {
          type: "campaign-message",
          id: input.messageId,
          relationships: {
            template: {
              data: {
                type: "template",
                id: input.templateId,
              },
            },
          },
        },
      },
    });
  }

  /**
   * @param {string} path
   * @param {{ method: string; step: string; body?: unknown; allowNoContent?: boolean }} input
   */
  async request(path, input) {
    const response = await this.fetchFn(`${KLAVIYO_API_BASE_URL}${path}`, {
      method: input.method,
      headers: {
        Authorization: `Klaviyo-API-Key ${this.privateKey}`,
        revision: KLAVIYO_REVISION,
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
    });

    if (!response.ok) {
      throw await KlaviyoApiError.fromResponse(response, input.step);
    }

    if (response.status === 204 || input.allowNoContent) return {};
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}

export class KlaviyoApiError extends Error {
  /** @param {{ code: string; message: string; status?: number | null; requestId?: string | null; retryable: boolean; step: string }} input */
  constructor(input) {
    super(input.message);
    this.name = "KlaviyoApiError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.requestId = input.requestId ?? null;
    this.retryable = input.retryable;
    this.step = input.step;
  }

  /** @param {Response} response @param {string} step */
  static async fromResponse(response, step) {
    let payload = {};
    try {
      const text = await response.text();
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }

    return new KlaviyoApiError({
      code: errorCodeForStatus(response.status, payload),
      message: safeErrorMessage(response.status, payload),
      status: response.status,
      requestId:
        response.headers.get("x-klaviyo-request-id") ??
        response.headers.get("request-id"),
      retryable: response.status === 429 || response.status >= 500,
      step,
    });
  }

  /** @param {string} step */
  withStep(step) {
    return new KlaviyoApiError({
      code: this.code,
      message: this.message,
      status: this.status,
      requestId: this.requestId,
      retryable: this.retryable,
      step,
    });
  }
}

/** @param {any} response @param {string} step */
function requiredId(response, step) {
  const id = response?.data?.id;
  if (typeof id === "string" && id.length > 0) return id;
  throw new KlaviyoApiError({
    code: "klaviyo_validation_error",
    message: "Klaviyo response did not include the expected ID.",
    retryable: false,
    step,
  });
}

/** @param {any} response */
function campaignMessageId(response) {
  const messageId =
    response?.data?.relationships?.["campaign-messages"]?.data?.[0]?.id ??
    response?.data?.attributes?.["campaign-messages"]?.data?.[0]?.id;
  return typeof messageId === "string" && messageId.length > 0
    ? messageId
    : null;
}

/** @param {string[]} items @param {number} size @returns {string[][]} */
function chunks(items, size) {
  /** @type {string[][]} */
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

/** @param {unknown} error @param {string} step */
function normalizeKlaviyoError(error, step) {
  if (error instanceof KlaviyoApiError) return error.withStep(step);
  return new KlaviyoApiError({
    code: "klaviyo_validation_error",
    message: error instanceof Error ? error.message : "Klaviyo API call failed.",
    retryable: false,
    step,
  });
}

/** @param {number} status @param {unknown} payload */
function errorCodeForStatus(status, payload) {
  const detail = JSON.stringify(payload).toLowerCase();
  if (status === 401 || status === 403) {
    return detail.includes("scope") ? "missing_scope" : "invalid_api_key";
  }
  if (status === 429) return "rate_limited";
  return "klaviyo_validation_error";
}

/** @param {number} status @param {unknown} payload */
function safeErrorMessage(status, payload) {
  const responsePayload = /** @type {{ errors?: Array<{ detail?: string; title?: string }> }} */ (
    objectValue(payload)
  );
  const errors = Array.isArray(responsePayload.errors)
    ? responsePayload.errors
    : [];
  const detail = errors
    .map((error) => error?.detail ?? error?.title)
    .filter(Boolean)
    .join("; ");

  return detail || `Klaviyo API returned HTTP ${status}.`;
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
