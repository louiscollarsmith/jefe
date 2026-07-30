// @ts-check

import { isRouteErrorResponse } from "react-router";

/**
 * Whether an error React Router's `handleError` sees should be **reported**
 * (logged at ERROR + captured to Sentry + alerted + recorded) or skipped as an
 * expected, non-fault signal. Two cases are skipped:
 *
 * - the request was **aborted** — the client disconnected mid-flight; and
 * - a **4xx route response** (a 404, a stray 405 POST to an actionless route, a
 *   403) — a client/bot error surfaced as a thrown route response, not a server
 *   fault.
 *
 * 5xx route responses and genuine unhandled exceptions report. Everything
 * unclassified reports too (fail open — better a little noise than silently
 * dropping a real fault). Pure + exported so this policy is unit-tested: the
 * failure modes are dropping real 5xx faults, or paging on every bot 404.
 *
 * @param {unknown} error
 * @param {{ aborted?: boolean }} [context]
 * @returns {boolean} true if the error should be reported
 */
export function shouldReportServerError(error, context = {}) {
  if (context.aborted) return false;
  if (isRouteErrorResponse(error) && error.status < 500) return false;
  return true;
}
