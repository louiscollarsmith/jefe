import { useEffect } from "react";

/**
 * Send → reply on screen, measured where the merchant is standing.
 *
 * The server already times its own share of a turn (`chat_turn` events, vantage
 * "server"), but that number cannot see the round trip or the home re-render the
 * redirect triggers — and those are part of the wait. This reports the whole
 * thing from the browser so the two can be compared: when felt latency moves and
 * no server phase does, the cost is in the navigation, not in Jefe thinking.
 *
 * The mark is kept in `sessionStorage` rather than component state deliberately:
 * a successful send redirects, so the composer unmounts before the reply exists.
 */

const MARK_KEY = "jefe.chatTurn.sentAt";
// Beyond this a mark is abandoned rather than slow — a merchant who sent a
// message and left the tab must not come back to a 20-minute "reply time".
const MAX_PLAUSIBLE_MS = 120_000;

type BridgeWithIdToken = { idToken?: () => Promise<string | undefined> };

/** Stamp the moment the merchant pressed Send. Safe to call anywhere, any surface. */
export function markChatTurnSent() {
  try {
    // Overwrites any earlier mark on purpose: the clock a merchant is watching is
    // the one for the message they just sent, not one they gave up on.
    window.sessionStorage.setItem(MARK_KEY, String(Date.now()));
  } catch {
    // Private mode / storage disabled — measuring must never block sending.
  }
}

function readAndClearMark(): number | null {
  try {
    const raw = window.sessionStorage.getItem(MARK_KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(MARK_KEY);
    const sentAt = Number(raw);
    return Number.isFinite(sentAt) ? sentAt : null;
  } catch {
    return null;
  }
}

/**
 * Reports the felt duration once Jefe's reply is the last thing in the thread.
 * Renders nothing, and every failure path is silent.
 */
export function ChatTurnReporter({
  lastMessageId,
  lastMessageRole,
}: {
  lastMessageId: string | null;
  lastMessageRole: string | null;
}) {
  useEffect(() => {
    // A reply is on screen when the thread ends with one. Anything else — the
    // merchant's own turn still awaiting an answer, an empty thread — is not a
    // completed turn, so the mark stays for the reply that is still coming.
    if (lastMessageRole !== "assistant") return;
    const sentAt = readAndClearMark();
    if (sentAt === null) return;
    const totalMs = Date.now() - sentAt;
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
          body: JSON.stringify({ totalMs }),
        });
      } catch {
        // Never surface a reporting failure to the merchant.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lastMessageId, lastMessageRole]);

  return null;
}
