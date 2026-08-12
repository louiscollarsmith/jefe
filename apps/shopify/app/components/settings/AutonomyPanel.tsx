import { useFetcher } from "react-router";
import { useState } from "react";

// The Settings → Autonomy panel: the per-action autonomy roster ("how much rope Jefe
// gets"). RESTORED after PR #75's home rewrite orphaned it (founder ruling 2026-08-12:
// bring back the approve / autonomous dial — it's the merchant's only way to opt into
// autonomy-from-install). Re-homed from the shelved `app-home/sections.tsx` into
// the /app/settings surface (chat 11's shell), restyled to the home tokens. Mounts in the
// settings slot, which already renders the "Autonomy" title + blurb — so this is just the
// roster content beneath it.
//
// LIVE vs "Soon" is ENGINE TRUTH, never hardcoded: `actionModes` (from the settings
// loader's getLiveActionModes → listActionTypes) carries a key per LIVE action type
// (registered + execute-flag on). Key present ⇒ a real dial at the merchant's stored mode;
// absent ⇒ the design row is kept visible per wire-or-keep but gated — a muted "Soon", or a
// real needs-you prompt (reordering). No fabricated dials; no fabricated numbers (the
// Pricing detail states the real guardrail — clearance floors at unit cost — not a margin %).

type ActionMode = "approve_execute" | "autonomous";

// Tokens mirrored from the home / settings shell (daily-home.tsx · app.settings.tsx).
const COLORS = {
  border: "#d8d0c8",
  hairline: "#ede7de",
  ink: "#1f2933",
  muted: "#6d7175",
  navy: "#1f3a63",
};
const SANS = "'Schibsted Grotesk', system-ui, -apple-system, sans-serif";
const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace";

// Two modes (founder ruling 2026-08-12 — advisory-only `recommend` dropped as a selectable
// mode: a dial whose first option is "don't actually help" undercut autonomy-from-install).
// Human-in-the-loop "Approve" or hands-off "Autonomous". The stored keys + the engine's mode
// semantics are UNTOUCHED — only the picker changed (removing a mode from the engine is one-way).
const MODE_OPTIONS: Array<{ value: ActionMode; label: string; hint: string }> = [
  { value: "approve_execute", label: "Approve", hint: "Jefe proposes it, you approve, then Jefe acts" },
  { value: "autonomous", label: "Autonomous", hint: "Jefe acts on its own, then tells you" },
];

// Design copy only — labels / detail / order + reordering's needs-you prompt, keyed by
// actionType (design_handoff / sample.ts). Which rows are LIVE comes from `actionModes`
// (engine truth), never this list. Pricing detail is the real guardrail ("never below what
// it cost you" — clearance floors at unit cost), not a margin % (copy per chat 11).
const ACTION_ROSTER: Array<{ actionType: string; label: string; detail: string; blockedReason?: string }> = [
  { actionType: "tidy_up", label: "Tidy-ups", detail: "Missing types, broken links, unclaimed refunds" },
  { actionType: "listing_copy", label: "Listing copy", detail: "Descriptions, titles, product types" },
  { actionType: "price_markdown", label: "Pricing", detail: "Never below what it cost you" },
  { actionType: "reordering", label: "Reordering", detail: "Blocked until Jefe knows your supplier lead times", blockedReason: "Tell me who supplies you" },
];

function isActionMode(v: string): v is ActionMode {
  return v === "approve_execute" || v === "autonomous";
}

// The stored mode → what the picker shows. A legacy stored `recommend` (dropped as a
// selectable mode 2026-08-12; there should be ~none — the dial only went live that day)
// displays as the safe default `approve_execute` until the merchant next sets it. The stored
// value + the engine's handling of `recommend` are left untouched (one-way — Matt's call).
// Anything unrecognised ⇒ no dial (the row falls through to "Soon" / its blocked prompt).
function displayMode(raw: string | undefined): ActionMode | null {
  if (!raw) return null;
  if (raw === "recommend") return "approve_execute";
  return isActionMode(raw) ? raw : null;
}

// The per-action autonomy dial. Posts action.set_mode via a fetcher to the surviving handler
// on the home route's action (app._index — reclaimed after PR #75, returns data not a
// redirect), so there's no navigation; an optimistic local highlight makes the choice stick
// without waiting on a loader refresh.
function ModePicker({ actionType, current }: { actionType: string; current: ActionMode }) {
  const fetcher = useFetcher();
  const [selected, setSelected] = useState<ActionMode>(current);
  return (
    <fetcher.Form method="post" action="/app?index" style={{ display: "inline-flex", flex: "none" }}>
      <input type="hidden" name="intent" value="action.set_mode" />
      <input type="hidden" name="actionType" value={actionType} />
      <div style={{ display: "inline-flex", border: `1px solid ${COLORS.border}`, borderRadius: 8, overflow: "hidden" }}>
        {MODE_OPTIONS.map((opt, i) => {
          const active = opt.value === selected;
          return (
            <button
              key={opt.value}
              type="submit"
              name="mode"
              value={opt.value}
              title={opt.hint}
              aria-pressed={active}
              onClick={() => setSelected(opt.value)}
              style={{
                fontFamily: SANS,
                fontSize: 12,
                fontWeight: 600,
                padding: "5px 12px",
                border: "none",
                borderLeft: i > 0 ? `1px solid ${COLORS.border}` : "none",
                cursor: "pointer",
                background: active ? COLORS.navy : "transparent",
                color: active ? "#fffdfa" : COLORS.ink,
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </fetcher.Form>
  );
}

export function AutonomyPanel({ actionModes }: { actionModes?: Record<string, string> }) {
  const modes = actionModes ?? {};
  return (
    <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
      {ACTION_ROSTER.map((row, i) => {
        const raw = modes[row.actionType];
        const liveMode = displayMode(raw);
        const last = i === ACTION_ROSTER.length - 1;
        return (
          <div
            key={row.actionType}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "13px 0",
              borderBottom: last ? "none" : `1px solid ${COLORS.hairline}`,
            }}
          >
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontFamily: SANS, fontSize: 13.5, fontWeight: 600, color: COLORS.ink }}>{row.label}</span>
              <span style={{ fontFamily: SANS, fontSize: 12.5, lineHeight: 1.45, color: COLORS.muted }}>{row.detail}</span>
            </div>
            {/* Live → the wired dial. Not-yet-live but kept visible (wire-or-keep): a real
                needs-you prompt (reordering) or a muted "Soon" — never a dial that can't act. */}
            {liveMode ? (
              <ModePicker actionType={row.actionType} current={liveMode} />
            ) : row.blockedReason ? (
              <span style={{ flex: "none", fontFamily: SANS, fontSize: 12.5, fontWeight: 600, color: COLORS.navy }}>{row.blockedReason}</span>
            ) : (
              <span style={{ flex: "none", fontFamily: MONO, fontSize: 9, letterSpacing: "0.5px", textTransform: "uppercase", color: COLORS.muted, border: `1px solid ${COLORS.hairline}`, borderRadius: 3, padding: "2px 5px", whiteSpace: "nowrap" }}>soon</span>
            )}
          </div>
        );
      })}
      <p style={{ margin: "16px 0 0", fontFamily: SANS, fontSize: 12.5, lineHeight: 1.55, color: COLORS.muted, borderLeft: `2px solid ${COLORS.navy}`, paddingLeft: 12 }}>
        On Autonomous, Jefe does what it can safely do on its own and checks with you on anything it can&apos;t — everything it does shows up in your chat, and stays reversible.
      </p>
    </div>
  );
}
