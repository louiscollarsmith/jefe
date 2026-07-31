import { useEffect } from "react";

type WebVitalMetric = { name: string; value: number };
type WebVitalsReport = { metrics?: WebVitalMetric[] };
type WebVitalsBridge = {
  webVitals?: { onReport?: (cb: (report: WebVitalsReport) => void) => void };
  idToken?: () => Promise<string | undefined>;
};

/**
 * Reports real-user Web Vitals to `/api/web-vitals`. Registers the App Bridge
 * `webVitals.onReport` callback (embedded context only) and beacons each report
 * with the id-token bearer. Fully guarded — a no-op with no App Bridge
 * (standalone) or an App Bridge build without the Web Vitals API — because perf
 * reporting must never break the app. Renders nothing.
 */
export function WebVitalsReporter({ enabled }: { enabled: boolean }) {
  useEffect(() => {
    if (!enabled) return;
    // App Bridge global (present in the embedded context). `webVitals` may be
    // absent on older App Bridge, so feature-detect everything.
    const bridge = (window as unknown as { shopify?: WebVitalsBridge }).shopify;
    if (!bridge?.webVitals?.onReport) return;

    let cancelled = false;
    const send = async (report: WebVitalsReport) => {
      if (cancelled) return;
      const metrics = Array.isArray(report?.metrics) ? report.metrics : [];
      if (!metrics.length) return;
      try {
        const idToken = await bridge.idToken?.();
        if (!idToken) return; // endpoint requires the bearer; skip if unavailable
        await fetch("/api/web-vitals", {
          method: "POST",
          keepalive: true,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ metrics }),
        });
      } catch {
        // Never surface a reporting failure to the merchant.
      }
    };

    try {
      bridge.webVitals.onReport(send);
    } catch {
      // onReport itself may be unavailable on older App Bridge — ignore.
    }
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return null;
}
