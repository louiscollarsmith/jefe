import type { CSSProperties, FormEvent } from "react";
import { useState } from "react";
import { Form, useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";

/**
 * Channels settings panel (mounts into app.settings.tsx `?panel=channels`). Slack-first and
 * deliberately focused — "get Slack going, nail one" (founder, 2026-08-12). Teams / iMessage /
 * WhatsApp are out of scope for this pass.
 *
 * Flow, reusing the existing infra:
 *   - Connect → POST /channels/slack/start (JSON) → OAuth popup → channels.slack.callback closes it
 *     and returns the opener to /app/settings?panel=channels.
 *   - Post-connect (refresh channels / save destination / disconnect) → POST /api/channels/slack.
 *
 * Pure presentational: the shell's loader supplies `connection` + `destinations`. Custom-styled to
 * match the settings shell (the redesigned surface is not Polaris).
 */

type SlackDestination = { id: string; label: string; isPrivate: boolean; isMember: boolean | null };

export type SlackConnectionView = {
  status: string;
  verified: boolean;
  accountName: string | null;
  destinationId: string | null;
  destinationLabel: string | null;
  errorMessage: string | null;
};

const OPS_PATH = "/api/channels/slack";

const NOT_CONNECTED = new Set(["not_connected", "disconnected", "connection_failed", "connection_expired"]);

export function ChannelsPanel({
  connection,
  destinations,
}: {
  connection: SlackConnectionView;
  destinations: SlackDestination[];
}) {
  const shopify = useAppBridge();
  const refresher = useFetcher<{ ok: boolean; destinations?: SlackDestination[]; error?: { message: string } }>();
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [chosen, setChosen] = useState<string>(connection.destinationId ?? "");

  const liveDestinations = refresher.data?.destinations ?? destinations;
  const notConnected = NOT_CONNECTED.has(connection.status);
  const configured = connection.verified && Boolean(connection.destinationLabel);

  async function connectSlack(event: FormEvent) {
    event.preventDefault();
    setLaunchError(null);
    setLaunching(true);
    // Open the popup synchronously (inside the click) so it isn't blocked, then point it at Slack.
    const popup = window.open("about:blank", "jefe-slack-oauth", "width=640,height=780,menubar=no,toolbar=no");
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      try {
        const token = await (shopify as { idToken?: () => Promise<string> }).idToken?.();
        if (token) headers.Authorization = `Bearer ${token}`;
      } catch {
        // Standalone (non-embedded) falls back to the cookie session — no bearer needed.
      }
      const res = await fetch("/channels/slack/start", { method: "POST", headers, body: new FormData() });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; redirectUrl?: string; error?: { message?: string } } | null;
      if (data?.ok && data.redirectUrl) {
        if (popup && !popup.closed) popup.location.href = data.redirectUrl;
        else window.open(data.redirectUrl, "jefe-slack-oauth");
      } else {
        popup?.close();
        setLaunchError(data?.error?.message ?? "Couldn't start the Slack connection. Please try again.");
      }
    } catch {
      popup?.close();
      setLaunchError("Couldn't reach Slack just now. Please try again.");
    } finally {
      setLaunching(false);
    }
  }

  // ── Not connected ──────────────────────────────────────────────────────────────
  if (notConnected) {
    return (
      <div style={wrap}>
        <SlackHeader />
        <p style={body}>
          Connect your Slack workspace and Jefe can reach you where you already work — a quick nudge
          when something needs you, answers when you ask.
        </p>
        {connection.errorMessage ? <p style={errorText}>{connection.errorMessage}</p> : null}
        {launchError ? <p style={errorText}>{launchError}</p> : null}
        <form method="post" action="/channels/slack/start" onSubmit={connectSlack}>
          <button type="submit" style={primaryBtn} disabled={launching}>
            {launching ? "Opening Slack…" : "Connect Slack"}
          </button>
        </form>
      </div>
    );
  }

  // ── Connected + a channel chosen ────────────────────────────────────────────────
  if (configured) {
    return (
      <div style={wrap}>
        <SlackHeader account={connection.accountName} />
        <p style={body}>
          Jefe posts to <strong>{connection.destinationLabel}</strong>
          {connection.accountName ? <> in {connection.accountName}</> : null}.
        </p>
        <details style={details}>
          <summary style={summary}>Change channel</summary>
          <DestinationPicker
            destinations={liveDestinations}
            chosen={chosen}
            onChoose={setChosen}
            refresher={refresher}
            refreshError={refresher.data && refresher.data.ok === false ? refresher.data.error?.message ?? null : null}
          />
        </details>
        <DisconnectButton />
      </div>
    );
  }

  // ── Connected, needs a channel ──────────────────────────────────────────────────
  return (
    <div style={wrap}>
      <SlackHeader account={connection.accountName} />
      <p style={body}>
        Connected{connection.accountName ? <> to <strong>{connection.accountName}</strong></> : null}. Choose the
        channel Jefe should post in — it’ll send a quick hello there to confirm.
      </p>
      {connection.errorMessage ? <p style={errorText}>{connection.errorMessage}</p> : null}
      <DestinationPicker
        destinations={liveDestinations}
        chosen={chosen}
        onChoose={setChosen}
        refresher={refresher}
        refreshError={refresher.data && refresher.data.ok === false ? refresher.data.error?.message ?? null : null}
      />
      <DisconnectButton />
    </div>
  );
}

function DestinationPicker({
  destinations,
  chosen,
  onChoose,
  refresher,
  refreshError,
}: {
  destinations: SlackDestination[];
  chosen: string;
  onChoose: (id: string) => void;
  refresher: ReturnType<typeof useFetcher>;
  refreshError: string | null;
}) {
  const refreshing = refresher.state !== "idle";
  return (
    <div style={pickerWrap}>
      {destinations.length > 0 ? (
        <div style={pickerRow}>
          <select
            value={chosen}
            onChange={(e) => onChoose(e.target.value)}
            aria-label="Slack channel"
            style={select}
          >
            <option value="">Choose a channel…</option>
            {destinations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
                {d.isPrivate ? " (private)" : ""}
              </option>
            ))}
          </select>
          <Form method="post" action={OPS_PATH}>
            <input type="hidden" name="intent" value="slack.save_destination" />
            <input type="hidden" name="destinationId" value={chosen} />
            <button type="submit" style={primaryBtn} disabled={!chosen}>
              Save channel
            </button>
          </Form>
        </div>
      ) : (
        <p style={subtle}>No channels loaded yet — reload to fetch the list from Slack.</p>
      )}
      <refresher.Form method="post" action={OPS_PATH}>
        <input type="hidden" name="intent" value="slack.refresh_destinations" />
        <button type="submit" style={linkBtn} disabled={refreshing}>
          {refreshing ? "Reloading…" : "Reload channels"}
        </button>
      </refresher.Form>
      {refreshError ? <p style={errorText}>{refreshError}</p> : null}
    </div>
  );
}

function DisconnectButton() {
  return (
    <Form method="post" action={OPS_PATH} style={{ marginTop: 4 }}>
      <input type="hidden" name="intent" value="slack.disconnect" />
      <button type="submit" style={dangerBtn}>
        Disconnect Slack
      </button>
    </Form>
  );
}

function SlackHeader({ account }: { account?: string | null }) {
  return (
    <div style={headerRow}>
      <img src="/channels/slack.webp" alt="" width={22} height={22} style={{ borderRadius: 4 }} />
      <span style={headerName}>Slack</span>
      {account ? <span style={connectedPill}>Connected</span> : null}
    </div>
  );
}

// ── tokens mirrored from the settings shell (app.settings.tsx) for visual consistency ──
const COLORS = {
  card: "#fffdfa",
  border: "#d8d0c8",
  hairline: "#ede7de",
  ink: "#1f2933",
  body: "#4d463f",
  muted: "#6d7175",
  navy: "#1f3a63",
  page: "#fbfaf7",
  danger: "#8c2f2f",
};
const SANS = "'Schibsted Grotesk', system-ui, -apple-system, sans-serif";

const wrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 14, fontFamily: SANS };
const headerRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const headerName: CSSProperties = { fontSize: 15, fontWeight: 700, color: COLORS.ink };
const connectedPill: CSSProperties = { fontSize: 11, fontWeight: 600, color: COLORS.navy, background: COLORS.page, border: `1px solid ${COLORS.hairline}`, borderRadius: 999, padding: "2px 8px" };
const body: CSSProperties = { margin: 0, fontSize: 13.5, lineHeight: 1.55, color: COLORS.body };
const subtle: CSSProperties = { margin: 0, fontSize: 12.5, color: COLORS.muted };
const errorText: CSSProperties = { margin: 0, fontSize: 12.5, lineHeight: 1.5, color: COLORS.danger };
const primaryBtn: CSSProperties = { appearance: "none", cursor: "pointer", fontSize: 13.5, fontWeight: 600, fontFamily: SANS, color: "#fff", background: COLORS.navy, border: "none", borderRadius: 8, padding: "9px 16px" };
const dangerBtn: CSSProperties = { appearance: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, fontFamily: SANS, color: COLORS.danger, background: "transparent", border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "8px 14px", alignSelf: "flex-start" };
const linkBtn: CSSProperties = { appearance: "none", cursor: "pointer", fontSize: 12.5, fontWeight: 600, fontFamily: SANS, color: COLORS.navy, background: "transparent", border: "none", padding: "4px 0", textDecoration: "underline", alignSelf: "flex-start" };
const pickerWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: "12px 0 2px" };
const pickerRow: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };
const select: CSSProperties = { flex: "1 1 200px", minWidth: 0, fontSize: 13.5, fontFamily: SANS, color: COLORS.ink, background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: "8px 10px" };
const details: CSSProperties = { border: `1px solid ${COLORS.hairline}`, borderRadius: 10, padding: "6px 12px", background: COLORS.page };
const summary: CSSProperties = { cursor: "pointer", fontSize: 13, fontWeight: 600, color: COLORS.navy };
