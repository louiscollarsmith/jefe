import type { LoaderFunctionArgs } from "react-router";
import type { CSSProperties } from "react";
import { Link, useLoaderData, useSearchParams } from "react-router";
import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { getLiveActionModes } from "../lib/actions/live-action-modes.server.js";
import { getDetectedToolStack } from "../lib/integrations/tool-stack-read.server.js";
import {
  listChannelConnections,
  listSlackDestinations,
} from "../lib/channels/service.server.js";
import { AutonomyPanel } from "../components/settings/AutonomyPanel";
import { IntegrationsPanel } from "../components/settings/IntegrationsPanel";
import type { DetectedToolStackView } from "../components/settings/IntegrationsPanel";
import { ChannelsPanel } from "../components/settings/ChannelsPanel";
import type { SlackConnectionView, SlackDestination } from "../components/settings/ChannelsPanel";

// The settings surface — a SEPARATE area from the (sleek, full-width) chat home.
// Founder ruling 2026-08-12: the home stays "just a chat log"; settings live here with a
// left-hand vertical sub-nav (Autonomy · Integrations · Channels · Notifications). This is a
// settings-scoped sub-nav, NOT the global Polaris Frame nav that was dropped in 0acdf68 —
// the home is untouched. It renders inside the app._index shell (app.tsx provides the
// App Bridge Frame), so no AppProvider here.
//
// This route is the SHELL + the destination slots. Each panel's CONTENT is owned by its
// lane and mounts into the active slot:
//   - Autonomy  → the roster session (approve / approve_execute / autonomous dial;
//                 lifts SettingsSection/ModePicker from the shelved app-home/sections.tsx)
//   - Channels  → the channels session (restore ChannelsStep + the 8 channel.* handlers,
//                 Slack-first) + fixes the Slack callback that lands on a dead step
//   - Integrations → detected-tools + connect UI (channels session + chat 9 data)
//   - Settings  → account/comms prefs (comms lane)
// Until an owner lands its panel, the slot shows an honest, merchant-facing "coming soon"
// state (no internal owner names, no fabricated controls). Reached from the home via the
// top-right gear (app.tsx shell) — founder ruling 2026-08-12: home stays clean/chat-only,
// settings behind a gear. Wired panels: Autonomy, Integrations, Channels (Slack-first).
// Notifications (email prefs — the composer's SettingsPanel) shows "coming soon" until wired.

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateAppRequest(request);
  const { merchant, shop } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "settings_shell" },
  });
  // Per-panel data is computed HERE — this surface's single loader — and passed to each
  // mounted panel as its documented prop (see the panel contract). Autonomy: the live
  // per-action modes (engine truth; an absent key ⇒ "Soon"/needs-you, never a fake dial).
  const actionModes = await getLiveActionModes(prisma, { merchantId: merchant.id });

  // Integrations: detected tool-stack (surfaceable-only, inference-framed in the panel). Empty
  // today (0 detections); no merchant claim until chat 10's signature verification.
  const toolStack = await getDetectedToolStack(prisma, { merchantId: merchant.id });

  // Channels (Slack-first): the slack connection + its available destinations. listChannel
  // connections always returns both providers; index/find gives the slack view (connected or not).
  const channelConnections = await listChannelConnections(prisma, {
    merchantId: merchant.id,
    shopId: shop.id,
  });
  const slackConnection =
    channelConnections.find((c) => c.provider === "slack") ?? channelConnections[0];
  // listSlackDestinations makes a LIVE Slack API call — only when there's a usable workspace,
  // and never let a token/API hiccup break the settings page (fall back to an empty list).
  const slackConnected = !["not_connected", "disconnected", "connection_failed", "connection_expired"].includes(
    slackConnection.status,
  );
  let slackDestinations: Awaited<ReturnType<typeof listSlackDestinations>> = [];
  if (slackConnected) {
    try {
      slackDestinations = await listSlackDestinations(prisma, {
        merchantId: merchant.id,
        shopId: shop.id,
      });
    } catch {
      slackDestinations = [];
    }
  }

  return { shopDomain: session.shop, actionModes, toolStack, slackConnection, slackDestinations };
};

// A settings destination. `ready` flips to true when its owning lane mounts its panel
// component here (swap the scaffold note for <TheirPanel data={...} />).
type PanelDef = { id: string; label: string; blurb: string; owner: string; ready: boolean };

// ORDER IS FOUNDER-SPECIFIED (Matt, 2026-08-12): Autonomy first (the most important control —
// don't let it drift down as panels fill in), then Integrations, Channels, Notifications last.
// This array IS the nav order + the contract's ordering source, so it holds regardless of which
// panels are `ready`. When wiring a panel, only flip its `ready` + add its PanelBody case —
// never reorder. `id` is the stable slug (used by ?panel=… and the Slack callback's
// /app/settings?panel=channels redirect); `label` may differ — "Notifications" keeps the
// `settings` slug (same principle as approve_execute keeping its stored value while relabelled).
const PANELS: PanelDef[] = [
  { id: "autonomy", label: "Autonomy", blurb: "How much rope Jefe gets, per kind of action.", owner: "roster session (the autonomy dial)", ready: true },
  { id: "integrations", label: "Integrations", blurb: "The tools Jefe reads — connect the ones you already use.", owner: "channels session + chat 9 (detected-tools data)", ready: true },
  { id: "channels", label: "Channels", blurb: "Where Jefe reaches you — Slack, WhatsApp, email.", owner: "channels session (Slack-first)", ready: true },
  { id: "settings", label: "Notifications", blurb: "Your morning brief — where it goes, when, and how often.", owner: "comms lane (email/notification prefs)", ready: false },
];

// The Merchant Memory view lives on the home route behind ?view=memory. Keep the embedded
// params (host, shop, embedded) and drop only our own ?panel.
function memoryHref(params: URLSearchParams) {
  const next = new URLSearchParams(params);
  next.delete("panel");
  next.set("view", "memory");
  return `/app?${next.toString()}`;
}

export default function SettingsSurface() {
  const data = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const requested = params.get("panel");
  const active = PANELS.find((p) => p.id === requested) ?? PANELS[0];
  // Slack OAuth/save/disconnect round-trips land back here with ?channelNotice=… — surface it
  // (it was orphaned: the callbacks passed it, nothing rendered it). Only on the Channels panel.
  const channelNotice = params.get("channelNotice");
  // Back to the home, preserving the embedded params (host, etc.) minus our own ?panel.
  const homeParams = new URLSearchParams(params);
  homeParams.delete("panel");
  const homeHref = `/app${homeParams.toString() ? `?${homeParams.toString()}` : ""}`;

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <Link to={homeHref} style={backLinkStyle}>
          ← Home
        </Link>
        <h1 style={titleStyle}>Settings</h1>
        <div style={rowStyle}>
          <nav style={navStyle} aria-label="Settings sections">
            {PANELS.map((p) => {
              const on = p.id === active.id;
              return (
                <Link
                  key={p.id}
                  to={`?panel=${p.id}`}
                  aria-current={on ? "page" : undefined}
                  style={{ ...navItemStyle, ...(on ? navItemActiveStyle : {}) }}
                >
                  {p.label}
                </Link>
              );
            })}
            {/* Merchant Memory is NOT a settings panel and deliberately not in PANELS — that
                array is founder-ordered and is the nav contract. It sits here because the
                home's link to it was removed (Matt: the chat-log home shouldn't carry it) and
                the gear became the way in. Without this the surface still renders and is
                still routed, and no merchant can open it. */}
            <Link to={memoryHref(params)} style={navItemStyle}>
              Everything Jefe knows
            </Link>
          </nav>

          <section style={panelStyle} aria-live="polite">
            <h2 style={panelTitleStyle}>{active.label}</h2>
            <p style={blurbStyle}>{active.blurb}</p>
            {active.id === "channels" && channelNotice ? <NoticeBanner code={channelNotice} /> : null}
            <PanelBody panel={active} data={data} />
          </section>
        </div>
      </div>
    </div>
  );
}

// The slot body: a mounted panel renders its own component (data-in, styled to the home
// tokens); an unmounted one keeps an honest scaffold note. Wire-or-keep — the destination is
// real, and each lane's content lands here as it's delivered. Adding a panel = one case here
// + its loader data + flipping the PANELS `ready` flag. See the published panel contract.
function PanelBody({
  panel,
  data,
}: {
  panel: PanelDef;
  data: {
    actionModes?: Record<string, string>;
    toolStack: DetectedToolStackView;
    slackConnection: SlackConnectionView;
    slackDestinations: SlackDestination[];
  };
}) {
  switch (panel.id) {
    case "autonomy":
      return <AutonomyPanel actionModes={data.actionModes} />;
    case "integrations":
      return <IntegrationsPanel data={data.toolStack} />;
    case "channels":
      return <ChannelsPanel connection={data.slackConnection} destinations={data.slackDestinations} />;
    default:
      // Merchant-facing honest state for a section still being built (wire-or-keep — the
      // section stays visible, no fabricated controls, and no internal owner names leak out).
      return (
        <div style={scaffoldStyle}>
          Coming soon — Jefe&apos;s still building this. It&apos;ll show up here when it&apos;s
          ready.
        </div>
      );
  }
}

// Slack round-trip confirmations (the ?channelNotice= codes the callbacks + /api/channels/slack
// redirect with). Known codes get plain merchant copy; anything else (an error code) falls back
// to a generic retry line — never a raw code shown to a merchant.
const CHANNEL_NOTICES: Record<string, { tone: "ok" | "warn"; text: string }> = {
  slack_connected: { tone: "ok", text: "Slack connected. Choose a channel below and save." },
  slack_saved: { tone: "ok", text: "Saved — Jefe will post to that Slack channel." },
  slack_disconnected: { tone: "warn", text: "Slack disconnected." },
  slack_destination_required: { tone: "warn", text: "Almost there — choose a Slack channel to finish." },
};

function NoticeBanner({ code }: { code: string }) {
  const notice =
    CHANNEL_NOTICES[code] ?? { tone: "warn" as const, text: "We couldn't finish connecting Slack. Please try again." };
  return (
    <div role="status" style={notice.tone === "ok" ? noticeOkStyle : noticeWarnStyle}>
      {notice.text}
    </div>
  );
}

// ── tokens mirrored from the home (daily-home.tsx) for visual consistency ──────────
const COLORS = {
  page: "#fbfaf7",
  card: "#fffdfa",
  border: "#d8d0c8",
  hairline: "#ede7de",
  ink: "#1f2933",
  body: "#4d463f",
  muted: "#6d7175",
  navy: "#1f3a63",
};
const SANS = "'Schibsted Grotesk', system-ui, -apple-system, sans-serif";

const pageStyle: CSSProperties = { minHeight: "100vh", background: COLORS.page, color: COLORS.ink, fontFamily: SANS, padding: "48px 24px 96px" };
const shellStyle: CSSProperties = { maxWidth: 900, margin: "0 auto", width: "100%", display: "flex", flexDirection: "column", gap: 28 };
const backLinkStyle: CSSProperties = { alignSelf: "flex-start", fontSize: 13, fontWeight: 600, color: COLORS.muted, textDecoration: "none" };
const titleStyle: CSSProperties = { margin: 0, fontSize: 26, fontWeight: 700, color: COLORS.ink };
const rowStyle: CSSProperties = { display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" };
const navStyle: CSSProperties = { flex: "0 0 200px", display: "flex", flexDirection: "column", gap: 2 };
const navItemStyle: CSSProperties = { display: "block", padding: "9px 12px", borderRadius: 8, fontSize: 14, fontWeight: 500, color: COLORS.body, textDecoration: "none", borderLeft: "2px solid transparent" };
const navItemActiveStyle: CSSProperties = { background: COLORS.card, borderLeft: `2px solid ${COLORS.navy}`, color: COLORS.ink, fontWeight: 600 };
const panelStyle: CSSProperties = { flex: "1 1 420px", minWidth: 0, background: COLORS.card, border: `1px solid ${COLORS.border}`, borderRadius: 14, padding: "22px 24px", display: "flex", flexDirection: "column", gap: 10 };
const panelTitleStyle: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 700, color: COLORS.ink };
const blurbStyle: CSSProperties = { margin: 0, fontSize: 13.5, lineHeight: 1.5, color: COLORS.muted };
const scaffoldStyle: CSSProperties = { marginTop: 6, padding: "14px 16px", border: `1px dashed ${COLORS.border}`, borderRadius: 10, fontSize: 13, lineHeight: 1.5, color: COLORS.muted, background: COLORS.page };
const noticeOkStyle: CSSProperties = { padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600, color: "#26723d", background: "#eef8f0", border: "1px solid #7fc08d" };
const noticeWarnStyle: CSSProperties = { padding: "10px 14px", borderRadius: 10, fontSize: 13, fontWeight: 600, color: "#8c4030", background: "#fbf1ec", border: "1px solid #e0b7a6" };
