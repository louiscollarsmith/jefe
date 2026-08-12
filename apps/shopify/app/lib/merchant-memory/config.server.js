// @ts-check

export function getMerchantMemoryV2Config() {
  return {
    contextEnabled: process.env.MERCHANT_CONTEXT_V2_ENABLED !== "false",
    passiveMemoryEnabled:
      process.env.MERCHANT_PASSIVE_MEMORY_ENABLED !== "false",
    defaultChatTokenBudget: 6000,
    maximumTokenBudget: 8000,
  };
}
