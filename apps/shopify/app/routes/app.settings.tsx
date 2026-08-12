import type { LoaderFunctionArgs } from "react-router";
import type { CSSProperties } from "react";
import { Link, useLoaderData, useSearchParams } from "react-router";
import prisma from "../db.server";
import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { getLiveActionModes } from "../lib/actions/live-action-modes.server.js";
import { AutonomyPanel } from "../components/settings/AutonomyPanel";

// The settings surface — a SEPARATE area from the (sleek, full-width) chat home.
// Founder ruling 2026-08-12: the home stays "just a chat log"; settings live here with a
// left-hand vertical sub-nav (Integrations · Channels · Settings · Autonomy). This is a
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
// settings behind a gear. Wired panels: Autonomy (Integrations is a fast-follow, pending a
// type-tighten on getDetectedToolStack's return; Channels/Settings show "coming soon").

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticateAppRequest(request);
  const { merchant } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: session.scope?.split(",").filter(Boolean) ?? [],
    rawPayload: { source: "settings_shell" },
  });
  // Per-panel data is computed HERE — this surface's single loader — and passed to each
  // mounted panel as its documented prop (see the panel contract). Autonomy: the live
  // per-action modes (engine truth; an absent key ⇒ "Soon"/needs-you, never a fake dial).
  // Integrations wiring is a fast-follow — its getDetectedToolStack return widens `status` to
  // string vs the panel's "detected"|"none_yet" union; the channels lane is tightening it.
  const actionModes = await getLiveActionModes(prisma, { merchantId: merchant.id });
  return { shopDomain: session.shop, actionModes };
};

// A settings destination. `ready` flips to true when its owning lane mounts its panel
// component here (swap the scaffold note for <TheirPanel data={...} />).
type PanelDef = { id: string; label: string; blurb: string; owner: string; ready: boolean };

const PANELS: PanelDef[] = [
  { id: "integrations", label: "Integrations", blurb: "The tools Jefe reads — connect the ones you already use.", owner: "channels session + chat 9 (detected-tools data)", ready: false },
  { id: "channels", label: "Channels", blurb: "Where Jefe reaches you — Slack, WhatsApp, email.", owner: "channels session (Slack-first)", ready: false },
  { id: "settings", label: "Settings", blurb: "Account, notifications, and data.", owner: "comms lane", ready: false },
  { id: "autonomy", label: "Autonomy", blurb: "How much rope Jefe gets, per kind of action.", owner: "roster session (the autonomy dial)", ready: true },
];

export default function SettingsSurface() {
  const data = useLoaderData<typeof loader>();
  const [params] = useSearchParams();
  const requested = params.get("panel");
  const active = PANELS.find((p) => p.id === requested) ?? PANELS[0];
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
          </nav>

          <section style={panelStyle} aria-live="polite">
            <h2 style={panelTitleStyle}>{active.label}</h2>
            <p style={blurbStyle}>{active.blurb}</p>
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
function PanelBody({ panel, data }: { panel: PanelDef; data: { actionModes?: Record<string, string> } }) {
  switch (panel.id) {
    case "autonomy":
      return <AutonomyPanel actionModes={data.actionModes} />;
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
