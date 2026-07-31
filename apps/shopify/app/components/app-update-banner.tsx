import { useEffect, useState } from "react";
import { Banner } from "@shopify/polaris";

/**
 * App-update poller + "Refresh" banner.
 *
 * A returning merchant who leaves the app open on one screen keeps running the
 * bundle their tab booted with. React Router already hard-reloads on a build
 * version-mismatch *when they navigate*, so the only gap is a truly idle tab
 * after a deploy. This surfaces a dismissible "Jefe's been updated — Refresh"
 * banner for that case (and heads off any rare mismatch error).
 *
 * How it knows:
 * - the running client bundle bakes in `VITE_APP_VERSION` at build (the Railway
 *   commit SHA — stamping owned by the architecture lane);
 * - the server exposes the *currently deployed* version at `/health` (`version`,
 *   same SHA basis). We poll and compare.
 *
 * Guardrails (coordinated with the build-version stamping):
 * - BOTH-defined guard: only ever prompt when the client's baked version AND the
 *   server's version are both present and differ. Until stamping ships, the
 *   client version is `undefined` → this stays fully inert (no false "refresh").
 * - No-op if `/health` errors, is unreachable, or omits `version`.
 * - Dismissible + non-nagging: once dismissed for a given server version, it
 *   won't re-prompt until an even newer version appears.
 */

const POLL_MS = 3 * 60 * 1000; // every 3 minutes
const HEALTH_URL = "/health";

// Baked into the client bundle at build time (same cast the Sentry client uses).
const CLIENT_VERSION =
  (import.meta.env.VITE_APP_VERSION as string | undefined) || undefined;

export function AppUpdateBanner() {
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  useEffect(() => {
    // No client version baked in → comparison is impossible; stay inert. This is
    // the state until the build-version stamping deploys, so the banner is a
    // guaranteed no-op until then.
    if (!CLIENT_VERSION) return;

    let cancelled = false;

    async function check() {
      try {
        const res = await fetch(HEALTH_URL, {
          headers: { accept: "application/json" },
          cache: "no-store",
        });
        if (!res.ok) return; // no-op on 404 / error
        const data = await res.json();
        const serverVersion =
          typeof data?.version === "string" ? data.version : null;
        if (!cancelled && serverVersion) setLatestVersion(serverVersion);
      } catch {
        // Network hiccup — ignore; the next tick retries.
      }
    }

    check();
    const id = window.setInterval(check, POLL_MS);
    // Also check when the merchant returns to the tab — the common idle case.
    const onWake = () => {
      if (document.visibilityState === "visible") check();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, []);

  const updateAvailable =
    !!CLIENT_VERSION &&
    !!latestVersion &&
    latestVersion !== CLIENT_VERSION &&
    dismissedVersion !== latestVersion;

  if (!updateAvailable) return null;

  return (
    <Banner
      tone="info"
      title="Jefe's been updated"
      action={{ content: "Refresh", onAction: () => window.location.reload() }}
      onDismiss={() => setDismissedVersion(latestVersion)}
    >
      A newer version is available. Refresh to get the latest.
    </Banner>
  );
}
