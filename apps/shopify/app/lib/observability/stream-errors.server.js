// @ts-check

/**
 * A benign streaming-SSR error: the client disconnected mid-stream (closed the
 * tab, navigated away, dropped its connection), so React's
 * `renderToPipeableStream` `onError` fires with "The destination stream errored
 * while writing data" or a socket/stream-closed error. That is the client going
 * away, not a server fault — it should log WARN, never page or hit Sentry.
 *
 * The strong signal at the call site is `request.signal.aborted`; this message
 * match is the belt-and-braces fallback for when the abort didn't propagate to
 * the signal in time. Kept deliberately specific (no bare "aborted") so a real
 * render error is never suppressed.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isBenignStreamError(error) {
  const message = String(
    (error && typeof error === "object" && "message" in error
      ? /** @type {{ message?: unknown }} */ (error).message
      : error) ?? "",
  );
  return /destination stream errored|ERR_STREAM_PREMATURE_CLOSE|premature close|write after end|stream (was )?(destroyed|closed)|EPIPE|ECONNRESET/i.test(
    message,
  );
}
