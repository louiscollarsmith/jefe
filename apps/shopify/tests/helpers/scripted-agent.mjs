/**
 * Scripted model for focused-action tests.
 *
 * These tests deliberately do **not** exercise a phrase matcher pretending to
 * be a model. Semantic understanding is the model's job and is covered by the
 * live evaluation corpus; what must be provably correct in CI is the runtime:
 * that planned tools actually run, that results reach the model, that state
 * changes are derived, and that the wording can never outrun the ledger.
 *
 * So a script here is the model's *decision*, stated plainly, and the test
 * asserts what the application then does with it.
 */

/**
 * @param {Array<any> | ((payload: any) => any)} script
 *   Either a list of turns returned in order, or a function of the prompt
 *   payload (so a test can react to tool results it has already seen).
 */
export function scriptedProvider(script) {
  const calls = [];
  let index = 0;
  return {
    enabled: true,
    provider: "test",
    model: "scripted-agent",
    calls,
    async generateStructuredJson({ prompt }) {
      const payload = typeof prompt === "string" ? JSON.parse(prompt) : prompt;
      calls.push(payload);
      const turn =
        typeof script === "function"
          ? script(payload)
          : (script[index] ?? { done: true, finalReply: null });
      index += 1;
      return { json: turn, provider: "test", model: "scripted-agent" };
    },
  };
}

/** A model that plans work and declares itself done in the same breath. */
export function eagerlyDoneProvider(toolCalls, finalReply = "Done.") {
  return scriptedProvider([{ done: true, finalReply, toolCalls }]);
}

/** A model that claims success having called nothing at all. */
export function emptySuccessProvider(finalReply = "Done.") {
  return scriptedProvider([{ done: true, finalReply, toolCalls: [] }]);
}

/**
 * Turn helper: request tools, then answer with whatever the test wants once
 * the results are visible.
 *
 * @param {Array<{ tool: string; arguments?: Record<string, any> }>} toolCalls
 * @param {string | null} finalReply
 */
export function planThenAnswer(toolCalls, finalReply) {
  return [
    { done: false, toolCalls },
    { done: true, finalReply, toolCalls: [] },
  ];
}

export function providerDown() {
  return { enabled: false, provider: "test", model: "offline" };
}
