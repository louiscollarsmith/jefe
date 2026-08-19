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

      // Assist-step semantic generation calls (artifact drafting) shouldn't
      // interfere with the planner's turn script.
      if (payload?.artifactType === "supplier_email_draft") {
        const groundingItems = Array.isArray(payload?.grounding?.items)
          ? payload.grounding.items
          : [];
        const itemsLen = groundingItems.length;

        const body =
          itemsLen > 0
            ? [
                "Hi,",
                "",
                "Could we please place a replenishment order for the following items?",
                "",
                ...groundingItems.map((item) => {
                  const units = item?.units ?? null;
                  return units != null ? `- ${item.title}: ${units} units` : `- ${item.title}: please confirm quantity`;
                }),
                "",
                "Please confirm lead time and availability.",
                "",
                "Thanks,",
              ].join("\n")
            : [
                "Hi,",
                "",
                "Could we please place a replenishment order for the low-cover items we discussed?",
                "",
                "Please confirm quantities, lead time, and availability.",
                "",
                "Thanks,",
              ].join("\n");

        return {
          json: {
            summary:
              itemsLen > 0
                ? `Drafted a supplier email covering ${itemsLen} item${itemsLen === 1 ? "" : "s"}.`
                : "Drafted a supplier email template for you to complete.",
            detail:
              "Copy, edit, or send this outside Jefe. Tell me what to change before you contact the supplier. I haven't placed or sent the supplier order.",
            nextPrompt: "Want me to change tone, quantities, or add delivery notes before you send it?",
            body,
            items: groundingItems.map((row) => ({ title: row.title, units: row.units ?? null })),
          },
          provider: "test",
          model: "scripted-agent",
        };
      }

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
