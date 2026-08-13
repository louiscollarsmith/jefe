import { useEffect } from "react";
import { useNavigation } from "react-router";

/**
 * The merchant's own clock: it starts when they say yes or press enter, and stops
 * when the result is on screen.
 *
 * The server times its own share of a turn (`chat_turn` events, vantage "server"),
 * but that number cannot see the round trip or the re-render the redirect triggers
 * — and the merchant sat through those too. This measures the whole wait from the
 * browser so the two can be compared: when felt latency moves and no server phase
 * does, the cost is in the navigation, not in Jefe thinking.
 *
 * Two kinds of wait, kept apart because blending them would hide both:
 * - `message` — Send → Jefe's reply in the thread.
 * - `approval` — Approve → the outcome of a real store change on screen.
 *
 * The mark lives in `sessionStorage` rather than component state deliberately:
 * both paths redirect, so the component that started the clock is gone before the
 * result exists.
 */

const MARK_KEY = "jefe.merchantWait";
// Beyond this a mark is abandoned rather than slow — a merchant who acted and
// left the tab must not come back to a twenty-minute "reply time".
const MAX_PLAUSIBLE_MS = 120_000;

export type MerchantWaitKind = "message" | "approval";

type BridgeWithIdToken = { idToken?: () => Promise<string | undefined> };
type Mark = { sentAt: number; kind: MerchantWaitKind };

function writeMark(kind: MerchantWaitKind) {
  try {
    // Overwrites any earlier mark on purpose: the clock a merchant is watching is
    // the one for the thing they just did, not one they gave up on.
    window.sessionStorage.setItem(
      MARK_KEY,
      JSON.stringify({ sentAt: Date.now(), kind }),
    );
  } catch {
    // Private mode / storage disabled — measuring must never block acting.
  }
}

/** Start the clock: the merchant pressed enter on a message. */
export function markChatTurnSent() {
  writeMark("message");
}

/** Start the clock: the merchant said yes to a move Jefe proposed. */
export function markApprovalSent() {
  writeMark("approval");
}

function peekMark(): Mark | null {
  try {
    const raw = window.sessionStorage.getItem(MARK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Mark>;
    const sentAt = Number(parsed?.sentAt);
    if (!Number.isFinite(sentAt)) return null;
    return {
      sentAt,
      kind: parsed?.kind === "approval" ? "approval" : "message",
    };
  } catch {
    return null;
  }
}

function clearMark() {
  try {
    window.sessionStorage.removeItem(MARK_KEY);
  } catch {
    // Nothing to do — a mark we cannot clear goes stale on its own.
  }
}

/**
 * Reports the felt duration once the result of the merchant's action is on
 * screen. Renders nothing, and every failure path is silent.
 */
export function ChatTurnReporter({
  lastMessageId,
  lastMessageRole,
}: {
  lastMessageId: string | null;
  lastMessageRole: string | null;
}) {
  const navigation = useNavigation();
  // Idle means React Router has finished the action AND the loader that followed
  // it, so what the merchant is looking at is the result rather than the old page.
  const settled = navigation.state === "idle";

  useEffect(() => {
    if (!settled) return;
    // Peek rather than take: a mark must survive renders that are not the result
    // it is waiting for, or a failed reply would be recorded as somebody else's.
    const mark = peekMark();
    if (!mark) return;
    // A reply is on screen when the thread ends with one. An approval has no
    // message to wait for — settling IS its result.
    if (mark.kind === "message" && lastMessageRole !== "assistant") return;

    const totalMs = Date.now() - mark.sentAt;
    clearMark();
    if (totalMs <= 0 || totalMs > MAX_PLAUSIBLE_MS) return;

    let cancelled = false;
    void (async () => {
      try {
        const bridge = (window as unknown as { shopify?: BridgeWithIdToken })
          .shopify;
        const idToken = await bridge?.idToken?.();
        if (!idToken || cancelled) return; // endpoint requires the bearer
        await fetch("/api/chat-turn", {
          method: "POST",
          keepalive: true,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ totalMs, kind: mark.kind }),
        });
      } catch {
        // Never surface a reporting failure to the merchant.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settled, lastMessageId, lastMessageRole]);

  return null;
}
