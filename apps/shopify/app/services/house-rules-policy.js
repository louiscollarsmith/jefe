// @ts-check

export const HOUSE_RULE_DEFAULTS = {
  maxDefaultDiscountPercent: "15",
  maxWinbackDiscountPercent: "10",
  minimumMarginPercent: "30",
  priorityMode: "protect_margin",
  maxEmailsPerCustomer: "1",
  emailFrequencyScope: "per_customer_per_week",
  maxCampaignAudienceSize: "500",
  emailCooldownDays: "7",
  allowWinbackDiscountAboveDefault: false,
  bfcmFreezeMode: false,
};

export const EMAIL_FREQUENCY_SCOPES = [
  "per_customer_per_week",
  "per_customer_per_month",
  "per_segment_per_week",
  "per_campaign_type",
];
