// @ts-check

import { redact } from "./redact.server.js";
import { getContext } from "./context.server.js";
import { createAlerter } from "./alerting.server.js";

/**
 * Minimal structured logger for the Shopify app.
 *
 * Design goals (see docs/observability.md):
 * - One line per event, JSON in production so Railway's log drain can parse it,
 *   human-readable in development.
 * - Levelled (`LOG_LEVEL`), so noisy debug logging can ship but stay off in prod.
 * - Every context payload is passed through `redact()` before it is written, so
 *   secrets and customer emails cannot leak into stdout.
 * - Shape-compatible with `Pick<Console, "info" | "warn" | "error">`, which is
 *   the logger interface the LLM provider and other modules already accept, so
 *   this can be injected wherever a `console` was previously used.
 *
 * No external dependency on purpose: this is the "basic" observability layer.
 */

/** @typedef {"debug" | "info" | "warn" | "error"} LogLevel */
/** @typedef {"json" | "pretty"} LogFormat */

/** @type {Record<string, number>} */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/**
 * @param {Record<string, string | undefined>} env
 * @returns {LogLevel}
 */
export function resolveLevel(env) {
  const raw = (env.LOG_LEVEL || "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(LEVELS, raw) && raw !== "silent") {
    return /** @type {LogLevel} */ (raw);
  }
  if (raw === "silent") return /** @type {LogLevel} */ ("silent");
  return (env.NODE_ENV || "development") === "production" ? "info" : "debug";
}

/**
 * @param {Record<string, string | undefined>} env
 * @returns {LogFormat}
 */
export function resolveFormat(env) {
  const fmt = (env.LOG_FORMAT || "").toLowerCase();
  if (fmt === "json") return "json";
  if (fmt === "pretty") return "pretty";
  return (env.NODE_ENV || "development") === "production" ? "json" : "pretty";
}

/**
 * Turn an Error into a plain, serialisable object. Own enumerable properties
 * (e.g. a typed error's `status`) are preserved; `cause` is followed one level.
 *
 * @param {unknown} error
 * @param {number} [depth]
 * @returns {unknown}
 */
export function serializeError(error, depth = 0) {
  if (!(error instanceof Error)) return error;
  /** @type {Record<string, unknown>} */
  const out = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  const bag = /** @type {Record<string, unknown>} */ (
    /** @type {unknown} */ (error)
  );
  for (const key of Object.keys(error)) {
    if (key === "name" || key === "message" || key === "stack") continue;
    if (key === "cause") continue;
    out[key] = bag[key];
  }
  if (error.cause !== undefined && depth < 2) {
    out.cause =
      error.cause instanceof Error
        ? serializeError(error.cause, depth + 1)
        : error.cause;
  }
  return out;
}

/**
 * Normalise the second argument of a log call into a context object. Accepts an
 * Error directly, an object (whose `err`/`error` Error fields get serialised),
 * or a primitive.
 *
 * @param {unknown} context
 * @returns {Record<string, unknown>}
 */
function normalizeContext(context) {
  if (context === undefined || context === null) return {};
  if (context instanceof Error) return { err: serializeError(context) };
  if (typeof context !== "object") return { value: context };

  const source = /** @type {Record<string, unknown>} */ (context);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(source)) {
    if ((key === "err" || key === "error") && source[key] instanceof Error) {
      out.err = serializeError(source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

/**
 * @param {LogLevel | "silent"} level
 * @param {string} line
 */
function defaultSink(level, line) {
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/**
 * @param {Record<string, unknown>} record
 * @returns {string}
 */
function formatPretty(record) {
  const { time, level, msg, ...rest } = record;
  const label = String(level).toUpperCase().padEnd(5);
  const context = Object.keys(rest).length ? ` ${safeJson(rest)}` : "";
  return `${time} ${label} ${msg}${context}`;
}

/**
 * JSON.stringify that never throws (falls back to a marker on failure).
 *
 * @param {unknown} value
 * @returns {string}
 */
function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"logger":"unserialisable record"}';
  }
}

/**
 * @typedef {object} LoggerOptions
 * @property {LogLevel | "silent"} [level] Explicit minimum level (overrides env).
 * @property {LogFormat} [format] Explicit format (overrides env).
 * @property {Record<string, string | undefined>} [env] Env used to resolve level/format.
 * @property {Record<string, unknown>} [bindings] Persistent context merged into every line.
 * @property {() => Date} [now] Clock, injectable for tests.
 * @property {(level: LogLevel | "silent", line: string) => void} [sink] Output sink, injectable for tests.
 * @property {(record: Record<string, unknown>) => void} [onError] Called (fire-and-forget) with the final, redacted record for every error-level event — used to forward alerts.
 */

/**
 * @typedef {object} Logger
 * @property {(msg: string, context?: unknown) => void} debug
 * @property {(msg: string, context?: unknown) => void} info
 * @property {(msg: string, context?: unknown) => void} warn
 * @property {(msg: string, context?: unknown) => void} error
 * @property {(bindings: Record<string, unknown>) => Logger} child
 * @property {LogLevel | "silent"} level
 */

/**
 * @param {LoggerOptions} [options]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const env = options.env ?? process.env;
  const level = options.level ?? resolveLevel(env);
  const format = options.format ?? resolveFormat(env);
  const bindings = options.bindings ?? {};
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? defaultSink;
  const onError = options.onError;
  const threshold = LEVELS[level] ?? LEVELS.info;

  /**
   * @param {LogLevel} lvl
   * @param {string} msg
   * @param {unknown} context
   */
  function emit(lvl, msg, context) {
    if (LEVELS[lvl] < threshold) return;
    const ctx = redact(normalizeContext(context));
    /** @type {Record<string, unknown>} */
    const record = {
      level: lvl,
      time: now().toISOString(),
      msg,
      ...getContext(),
      ...bindings,
      .../** @type {Record<string, unknown>} */ (ctx),
    };
    const line = format === "json" ? safeJson(record) : formatPretty(record);
    sink(lvl, line);
    if (lvl === "error" && onError) {
      try {
        onError(record);
      } catch {
        // Alert forwarding must never break logging.
      }
    }
  }

  /** @type {Logger} */
  const logger = {
    level,
    debug: (msg, context) => emit("debug", msg, context),
    info: (msg, context) => emit("info", msg, context),
    warn: (msg, context) => emit("warn", msg, context),
    error: (msg, context) => emit("error", msg, context),
    child: (childBindings) =>
      createLogger({
        ...options,
        level,
        format,
        bindings: { ...bindings, ...childBindings },
      }),
  };
  return logger;
}

/**
 * Process-wide default logger. Import this in server-only modules
 * (`*.server.ts` / `*.server.js` / entry.server) — never in code that ships to
 * the browser bundle.
 *
 * Error-level events are forwarded to the ops alerter (a no-op unless
 * `ALERT_WEBHOOK_URL` is configured).
 */
const defaultAlerter = createAlerter();

/** @type {Logger} */
export const logger = createLogger({
  onError: (record) => defaultAlerter.notify(record),
});
