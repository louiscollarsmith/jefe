import type { CSSProperties } from "react";

/**
 * Integrations settings panel (mounts into app.settings.tsx `?panel=integrations`).
 *
 * "The tools Jefe reads — connect the ones you already use." It opens by showing what Jefe has
 * DETECTED, then offers to connect. Detection is model inference, and the detection signatures are
 * still being verified against real stores — so this surface is the false-positive gate for the
 * whole tool-stack feature:
 *   - render **surfaceable-only** (confidence ≥ 0.7 AND, once wired, chat 10's per-signature verdict)
 *   - frame everything as "Jefe spotted / we think", never a bare assertion (provenance: "inference")
 *   - the connect CTA is honestly gated "coming soon" — never a fake working button
 * There are 0 detections on prod today, so every current merchant sees the honest empty state.
 *
 * Pure presentational: the shell's loader supplies `data` from getDetectedToolStack(). Custom-styled
 * to match the settings shell's tokens (the redesigned surface is not Polaris).
 *
 * Follow-up (needs chat 9's belief-correction write): a sticky one-tap "not using this" dismiss.
 */

type ConnectOffer = { status: string; cta: string };
type DetectedTool = {
  id: string;
  name: string;
  category: string;
  categoryLabel: string;
  confidence: number | null;
  confidenceBand: "high" | "medium" | "low" | "unknown";
  surfaceable: boolean;
  detectedVia: string;
  connected: boolean;
  connectOffer: ConnectOffer;
};

export type DetectedToolStackView = {
  provenance: string;
  tools: DetectedTool[];
  count: number;
  surfaceableCount: number;
  empty: boolean;
  headline: string | null;
  status: "detected" | "none_yet";
};

export function IntegrationsPanel({ data }: { data: DetectedToolStackView }) {
  // Surfaceable-only is the safety gate — never show a below-threshold match as a firm detection.
  const firm = data.tools.filter((t) => t.surfaceable);

  if (firm.length === 0) {
    return (
      <div style={wrapStyle}>
        <div style={emptyStyle}>
          <p style={emptyLeadStyle}>Jefe’s still learning your stack.</p>
          <p style={emptyBodyStyle}>
            As it reads your store’s orders, checkout and product data, it spots the tools you already
            use — the Klaviyos, Recharges and ShipStations — and offers to connect them here. Nothing
            spotted yet; this fills in as Jefe gets to know your store.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      {data.headline ? <p style={headlineStyle}>{data.headline}</p> : null}
      <p style={inferenceNoteStyle}>
        Jefe’s best guess from signals in your store — not confirmed. Tell us if anything here is off.
      </p>

      <ul style={listStyle}>
        {firm.map((tool) => (
          <li key={tool.id} style={rowStyle}>
            <div style={rowMainStyle}>
              <span style={toolNameStyle}>{tool.name}</span>
              <span style={categoryStyle}>{tool.categoryLabel}</span>
              <span style={viaStyle}>We think so — spotted via {tool.detectedVia}.</span>
            </div>
            <ConnectCta offer={tool.connectOffer} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The connect CTA — honestly gated. "coming_soon" renders a non-interactive pill, not a fake button. */
function ConnectCta({ offer }: { offer: ConnectOffer }) {
  if (offer.status === "coming_soon") {
    return (
      <span style={comingSoonStyle} aria-disabled="true" title="Connecting is coming soon">
        Coming soon
      </span>
    );
  }
  // No other status ships yet; render the label without a fake action rather than invent a flow.
  return <span style={comingSoonStyle}>{offer.cta}</span>;
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
};
const SANS = "'Schibsted Grotesk', system-ui, -apple-system, sans-serif";

const wrapStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 14, fontFamily: SANS };
const headlineStyle: CSSProperties = { margin: 0, fontSize: 15, fontWeight: 600, color: COLORS.ink };
const inferenceNoteStyle: CSSProperties = { margin: 0, fontSize: 12.5, lineHeight: 1.5, color: COLORS.muted };
const listStyle: CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 };
const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "12px 14px",
  border: `1px solid ${COLORS.hairline}`,
  borderRadius: 10,
  background: COLORS.page,
};
const rowMainStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const toolNameStyle: CSSProperties = { fontSize: 14, fontWeight: 600, color: COLORS.ink };
const categoryStyle: CSSProperties = { fontSize: 12, color: COLORS.navy, fontWeight: 500 };
const viaStyle: CSSProperties = { fontSize: 12, color: COLORS.muted, lineHeight: 1.4 };
const comingSoonStyle: CSSProperties = {
  flex: "0 0 auto",
  fontSize: 12,
  fontWeight: 600,
  color: COLORS.muted,
  padding: "6px 12px",
  border: `1px dashed ${COLORS.border}`,
  borderRadius: 999,
  whiteSpace: "nowrap",
};
const emptyStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const emptyLeadStyle: CSSProperties = { margin: 0, fontSize: 14.5, fontWeight: 600, color: COLORS.ink };
const emptyBodyStyle: CSSProperties = { margin: 0, fontSize: 13, lineHeight: 1.55, color: COLORS.body };
