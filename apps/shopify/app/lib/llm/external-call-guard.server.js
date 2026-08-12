// @ts-check

import { LlmDisabledError } from "./errors.server.js";

/** @param {NodeJS.ProcessEnv} [env] */
export function externalLlmCallsDisabled(env = process.env) {
  return (
    env.JEFE_EXTERNAL_LLM_DISABLED === "true" ||
    env.NODE_ENV === "test" ||
    Boolean(env.NODE_TEST_CONTEXT) ||
    process.execArgv.includes("--test")
  );
}

/**
 * Tests may exercise provider behavior only through an explicitly injected
 * mock transport. No test execution is allowed to reach an external model.
 *
 * @param {{ hasInjectedTransport?: boolean }} [input]
 */
export function assertExternalLlmCallAllowed(input = {}) {
  if (input.hasInjectedTransport || !externalLlmCallsDisabled()) return;
  throw new LlmDisabledError("External LLM calls are disabled during tests.");
}
