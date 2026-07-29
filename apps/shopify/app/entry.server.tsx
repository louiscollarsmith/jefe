import { PassThrough } from "stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, isRouteErrorResponse } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { type EntryContext, type HandleErrorFunction } from "react-router";
import { isbot } from "isbot";
import { addDocumentResponseHeaders } from "./shopify.server";
import { getShopifyStandaloneDocumentResponse } from "./services/shopify-document-response.server";
import { logger } from "./lib/observability/logger.server";
import { newCorrelationId } from "./lib/observability/context.server";
import { initSentry, captureError } from "./lib/observability/sentry.server";
import { recordRequestDuration } from "./lib/observability/perf.server";
import db from "./db.server";
import { track } from "./services/analytics/event-log.server";

// Inert unless SENTRY_DSN is set.
initSentry();

export const streamTimeout = 5000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext
) {
  const requestStart = Date.now();
  addDocumentResponseHeaders(request, responseHeaders);
  const standaloneShopifyResponse = getShopifyStandaloneDocumentResponse({
    responseStatusCode,
    responseHeaders,
    reactRouterContext,
  });
  if (standaloneShopifyResponse) return standaloneShopifyResponse;

  const userAgent = request.headers.get("user-agent");
  const callbackName = isbot(userAgent ?? '')
    ? "onAllReady"
    : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter
        context={reactRouterContext}
        url={request.url}
      />,
      {
        [callbackName]: () => {
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");
          recordRequestDuration(Date.now() - requestStart);
          resolve(
            new Response(stream, {
              headers: responseHeaders,
              status: responseStatusCode,
            })
          );
          pipe(body);
        },
        onShellError(error) {
          reject(error);
        },
        onError(error) {
          responseStatusCode = 500;
          logger.error("Streaming render error", { err: error });
          captureError(error);
        },
      }
    );

    // Automatically timeout the React renderer after 6 seconds, which ensures
    // React has enough time to flush down the rejected boundary contents
    setTimeout(abort, streamTimeout + 1000);
  });
}

/**
 * Central server-side error hook. React Router calls this for every uncaught
 * error thrown while handling a request (loaders, actions and rendering), so it
 * is the one place guaranteed to see them. Two expected, non-actionable cases
 * are skipped: client disconnects (aborted requests) and 404s.
 */
export const handleError: HandleErrorFunction = (error, { request }) => {
  if (request.signal.aborted) return;
  if (isRouteErrorResponse(error) && error.status === 404) return;

  const url = new URL(request.url);
  const correlationId = request.headers.get("x-request-id") || newCorrelationId();
  logger.error("Unhandled server error", {
    err: error,
    method: request.method,
    path: url.pathname,
    correlationId,
  });
  captureError(error, {
    method: request.method,
    path: url.pathname,
    correlationId,
  });
  // Record it in the activity log (topic "reliability") so errors are readable
  // from the panel + DB by any session, not just via the Slack push.
  void track(db, {
    type: "server_error",
    topic: "reliability",
    summary: `${request.method} ${url.pathname}: ${
      error instanceof Error ? error.message : String(error)
    }`.slice(0, 300),
    properties: { path: url.pathname, correlationId },
  });
};
