import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";
import { useEffect } from "react";
import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";
import "@shopify/polaris/build/esm/styles.css";
import "./styles/jefe.css";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        {/* Cinematic type (Instrument Serif display, IBM Plex Mono labels, Bricolage
            wordmark, Schibsted body). Confirmed not the cause of the earlier embedded
            "stuck loading" (that was a screenshot-tool artifact), so loaded normally. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Schibsted+Grotesk:wght@400;500;600;700;800&family=Bricolage+Grotesque:wght@600;700&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <PolarisAppProvider i18n={enTranslations}>
          <Outlet />
          <ScrollRestoration />
          <Scripts />
        </PolarisAppProvider>
      </body>
    </html>
  );
}

/**
 * Top-level error boundary. Catches any error not handled by a nested route
 * boundary (e.g. the embedded `app/*` routes have their own) and renders a
 * clean, self-contained fallback instead of a raw stack trace. Kept free of
 * server-only imports so it is safe in the client bundle; server-side logging
 * of these errors is handled centrally by `handleError` in entry.server.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const routeError = isRouteErrorResponse(error);

  // Report genuine exceptions (not 4xx/5xx route responses, which are expected
  // control flow) to Sentry from the browser. SSR errors are already captured
  // server-side in entry.server's handleError; this adds the client half —
  // render errors during client navigation that never reach the server. The
  // dynamic import keeps Sentry out of the SSR path and the initial bundle.
  useEffect(() => {
    if (routeError) return;
    import("./lib/observability/sentry.client")
      .then((m) => m.captureClientError(error))
      .catch(() => {});
  }, [error, routeError]);

  const heading = routeError ? String(error.status) : "Something went wrong";
  const detail = routeError
    ? error.statusText || "This page could not be loaded."
    : "An unexpected error occurred. Please try again.";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{`${heading} · Jefe`}</title>
        <Meta />
        <Links />
      </head>
      <body>
        <main
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "0.5rem",
            padding: "2rem",
            textAlign: "center",
            fontFamily:
              "'Schibsted Grotesk', system-ui, -apple-system, sans-serif",
            color: "#1a1a1a",
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: "0.75rem",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              opacity: 0.6,
            }}
          >
            Jefe
          </p>
          <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700 }}>
            {heading}
          </h1>
          <p style={{ margin: 0, maxWidth: "32rem", opacity: 0.8 }}>{detail}</p>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
