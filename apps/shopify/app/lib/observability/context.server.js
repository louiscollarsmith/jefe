// @ts-check

import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";

/**
 * Per-operation logging context, propagated with `AsyncLocalStorage`.
 *
 * Any bindings established with {@link runWithContext} (e.g. a `correlationId`,
 * `jobId`, `shopDomain`) are automatically merged into every log line the
 * structured logger emits within that async call tree — including logs from
 * code it awaits, such as the LLM provider. This is what lets a single job run's
 * logs (job → memory rebuild → LLM calls) line up under one id without threading
 * an id argument through every function.
 *
 * The store propagates across `await` boundaries but NOT across process/queue
 * boundaries — a correlationId minted here does not travel into a DB-persisted
 * job and back out. That cross-boundary propagation is a deliberate follow-up.
 */

/** @typedef {Record<string, unknown>} LogContext */

/** @type {AsyncLocalStorage<LogContext>} */
const storage = new AsyncLocalStorage();

/**
 * Run `fn` with `bindings` merged onto any surrounding context. Returns whatever
 * `fn` returns (so it composes with async functions).
 *
 * @template T
 * @param {LogContext} bindings
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithContext(bindings, fn) {
  const parent = storage.getStore();
  const store = { ...(parent ?? {}), ...bindings };
  return storage.run(store, fn);
}

/**
 * Current context bindings, or an empty object when running outside any context.
 *
 * @returns {LogContext}
 */
export function getContext() {
  return storage.getStore() ?? {};
}

/**
 * Generate a fresh correlation id.
 *
 * @returns {string}
 */
export function newCorrelationId() {
  return crypto.randomUUID();
}
