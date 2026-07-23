// @ts-check

import { DETERMINISTIC_BELIEF_REGISTRY } from "./deterministic-belief-registry.server.js";

export const DETERMINISTIC_CONFIDENCE_REGISTRY = Object.fromEntries(
  DETERMINISTIC_BELIEF_REGISTRY.map((definition) => [
    definition.key,
    confidenceConfigForDefinition(definition),
  ]),
);

/** @param {{ key: string; confidenceTemplate?: string; confidenceTemplateVersion?: string; confidenceParameters?: Record<string, any>; confidenceComponents?: any[]; confidencePublishPolicy?: string; dataQualityFlags?: string[] }} definition */
export function getConfidenceConfig(definition) {
  return (
    DETERMINISTIC_CONFIDENCE_REGISTRY[definition.key] ??
    confidenceConfigForDefinition(definition)
  );
}

/** @param {{ confidenceTemplate?: string; confidenceTemplateVersion?: string; confidenceParameters?: Record<string, any>; confidenceComponents?: any[]; confidencePublishPolicy?: string; dataQualityFlags?: string[] }} definition */
function confidenceConfigForDefinition(definition) {
  return {
    template: definition.confidenceTemplate ?? "direct_observation_v1",
    templateVersion: definition.confidenceTemplateVersion ?? "v1",
    params: definition.confidenceParameters ?? {},
    components: definition.confidenceComponents ?? [],
    publishPolicy:
      definition.confidencePublishPolicy ?? "publish_when_minimum_data_met",
    dataQualityFlags: definition.dataQualityFlags ?? [],
  };
}
