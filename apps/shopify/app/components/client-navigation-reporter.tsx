import { useEffect, useRef } from "react";
import { useLocation, useNavigation } from "react-router";

type BridgeWithIdToken = { idToken?: () => Promise<string | undefined> };
type PendingNavigation = {
  fromPath: string;
  toPath: string;
  kind: string;
  startedAt: number;
};

const MAX_PLAUSIBLE_MS = 120_000;

export function ClientNavigationReporter({ enabled }: { enabled: boolean }) {
  const location = useLocation();
  const navigation = useNavigation();
  const pending = useRef<PendingNavigation | null>(null);
  const currentPath = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (!enabled) return;
    if (navigation.state !== "idle" && navigation.location) {
      const toPath = `${navigation.location.pathname}${navigation.location.search}`;
      if (!pending.current || pending.current.toPath !== toPath) {
        pending.current = {
          fromPath: currentPath,
          toPath,
          kind: classifyNavigation(currentPath, toPath),
          startedAt: Date.now(),
        };
      }
      return;
    }

    const mark = pending.current;
    if (!mark) return;
    if (mark.toPath !== currentPath) return;
    pending.current = null;

    const totalMs = Date.now() - mark.startedAt;
    if (totalMs <= 0 || totalMs > MAX_PLAUSIBLE_MS) return;

    void sendNavigationTiming({ ...mark, totalMs });
  }, [enabled, navigation.state, navigation.location, currentPath]);

  return null;
}

function classifyNavigation(fromPath: string, toPath: string) {
  const from = safeUrl(fromPath);
  const to = safeUrl(toPath);
  if (!from || !to) return "route";
  if (from.pathname !== to.pathname) return "route";
  if (from.pathname === "/app") {
    const changed = changedSearchKeys(from.searchParams, to.searchParams);
    if (changed.every((key) => ["conversation", "talkAction", "actionChat"].includes(key))) {
      return "app_home_overlay";
    }
  }
  return "search";
}

function changedSearchKeys(a: URLSearchParams, b: URLSearchParams) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((key) => a.getAll(key).join("\u0000") !== b.getAll(key).join("\u0000"));
}

function safeUrl(path: string) {
  try {
    return new URL(path, "https://jefe.local");
  } catch {
    return null;
  }
}

async function sendNavigationTiming(input: PendingNavigation & { totalMs: number }) {
  try {
    const bridge = (window as unknown as { shopify?: BridgeWithIdToken }).shopify;
    const idToken = await bridge?.idToken?.();
    if (!idToken) return;
    await fetch("/api/client-navigation", {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(input),
    });
  } catch {
    // Navigation measurement must never affect navigation.
  }
}
