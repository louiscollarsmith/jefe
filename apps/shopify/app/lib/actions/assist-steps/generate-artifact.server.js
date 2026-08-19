// @ts-check

/**
 * LLM-owned semantic artifact generation.
 *
 * Application code provides grounding + a strict JSON schema. The model
 * generates the human-facing prose/content; the caller remains responsible
 * for validation and grounding enforcement.
 *
 * @param {any} provider
 * @param {{
 *   systemPrompt: string[];
 *   objective: string;
 *   artifactType: string;
 *   grounding: any;
 *   schema: any;
 *   maxOutputTokens?: number;
 * }} input
 */
export async function generateSemanticArtifact(provider, input) {
  if (!provider || typeof provider.generateStructuredJson !== "function") {
    throw new Error("LLM provider is unavailable for semantic artifact generation.");
  }

  const generated = await provider.generateStructuredJson({
    systemPrompt: input.systemPrompt,
    prompt: JSON.stringify({
      artifactType: input.artifactType,
      objective: input.objective,
      grounding: input.grounding,
    }),
    schema: input.schema,
    maxOutputTokens: input.maxOutputTokens ?? 900,
  });

  return generated?.json ?? null;
}

