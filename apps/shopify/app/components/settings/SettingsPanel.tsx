import { Form } from "react-router";
import { useState } from "react";
import type { CSSProperties } from "react";

// The merchant's in-app control over the emails Jefe sends — re-homed here after
// PR #75 removed the old Settings pane (chat 10's ruling: notification.set is a
// KEEP/re-home, not a delete). Restore-priority + compliance-adjacent: ENABLE_EMAIL
// is on in prod and win-back is sending, so a merchant needs an in-app way to tune
// / turn off Jefe's emails (the in-email one-click unsubscribe keeps us legally
// covered meanwhile — verified live).
//
// SELF-CONTAINED per chat 11's mount contract: this is a pure, prop-driven control.
// chat 11 wires it into the /app/settings PANELS registry and feeds `emailBrief`
// from the loader (helpers, all on main: getShopContactEmail + getNotification
// Preference("morning_brief") + formatBriefSendTime). The <Form> posts the existing
// `notification.set` intent (app._index action) — the route that mounts this must
// route that intent to the app._index action handler.
//
// Honest by construction: the row renders only what's real — the merchant's actual
// contact email + their stored morning-brief pref. No contact email ⇒ an honest
// "no email on file" state, never a fabricated address. Styled to Louis's home
// tokens (not the 13a register) so it sits natively in the new Settings surface.

const COLORS = {
  card: "#fffdfa",
  border: "#d8d0c8",
  hairline: "#ede7de",
  ink: "#1f2933",
  body: "#4d463f",
  muted: "#6d7175",
  meta: "#8a8177",
  navy: "#1f3a63",
  surface: "#fbfaf7",
};
const FONT = {
  sans: "'Schibsted Grotesk', system-ui, -apple-system, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
};

export type EmailBrief = {
  address: string;
  enabled: boolean;
  sendTime: string | null; // display, e.g. "7:30am"
  hour: number | null;
  minute: number | null;
  frequency: string; // "daily" | "weekdays" | "off"
  sending: boolean; // is scheduled delivery actually live yet (ENABLE_MORNING_BRIEF)?
};

export type SettingsPanelProps = {
  /** The merchant's morning-brief email pref + real contact address; null when no
   *  contact email is known (loader couldn't resolve shop { email }). */
  emailBrief?: EmailBrief | null;
};

export function SettingsPanel({ emailBrief }: SettingsPanelProps) {
  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <h2 style={titleStyle}>How Jefe emails you</h2>
        <p style={subtitleStyle}>
          Jefe emails you the morning brief and the occasional win-back. You can tune the brief
          here, and turn it off any time. Every Jefe email also carries a one-click unsubscribe.
        </p>
      </div>
      {emailBrief ? (
        <EmailBriefRow brief={emailBrief} />
      ) : (
        <div style={rowStyle}>
          <span style={rowLabelStyle}>Morning brief by email</span>
          <span style={{ ...rowValueStyle, color: COLORS.meta }}>
            No email on file yet — Jefe will use your store contact email once it can read it.
          </span>
        </div>
      )}
    </div>
  );
}

function EmailBriefRow({ brief }: { brief: EmailBrief }) {
  const [editing, setEditing] = useState(false);
  const time24 =
    brief.hour != null && brief.minute != null
      ? `${String(brief.hour).padStart(2, "0")}:${String(brief.minute).padStart(2, "0")}`
      : "07:30";
  const note = !brief.enabled
    ? "Paused — you won't get the morning brief."
    : brief.sending
      ? null
      : "Not sending yet — starts when daily briefs go live.";

  return (
    <div style={rowStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
        <span style={rowLabelStyle}>Morning brief by email</span>
        <button type="button" onClick={() => setEditing((v) => !v)} style={changeLinkStyle}>
          {editing ? "Close" : "Change"}
        </button>
      </div>
      <span style={rowValueStyle}>
        {brief.enabled && brief.sendTime ? `${brief.address} · ${brief.sendTime}` : brief.address}
      </span>
      {note ? <span style={noteStyle}>{note}</span> : null}

      {editing ? (
        // action="/app?index" so the notification.set handler on the app._index route
        // receives the post even when this panel is mounted on the separate /app/settings
        // route (the published settings-panel form-action rule; mirrors AutonomyPanel).
        <Form method="post" action="/app?index" style={formStyle}>
          <input type="hidden" name="intent" value="notification.set" />
          <input type="hidden" name="category" value="morning_brief" />
          <input type="hidden" name="frequency" value={brief.frequency || "daily"} />
          {/* hidden false + checkbox true → unchecked disables, checked enables
              (the notification.set handler reads getAll().some) */}
          <input type="hidden" name="enabled" value="false" />
          <label style={fieldStyle}>
            <input type="checkbox" name="enabled" value="true" defaultChecked={brief.enabled} />
            Send me the morning brief
          </label>
          <label style={fieldStyle}>
            Send time
            <input type="time" name="time" defaultValue={time24} style={timeInputStyle} />
          </label>
          <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
            <button type="submit" style={saveButtonStyle}>Save</button>
            <button type="button" onClick={() => setEditing(false)} style={cancelButtonStyle}>Cancel</button>
          </div>
        </Form>
      ) : null}
    </div>
  );
}

const panelStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 16,
  padding: "clamp(20px, 3vw, 32px)",
  display: "flex",
  flexDirection: "column",
  gap: 20,
  fontFamily: FONT.sans,
  color: COLORS.ink,
  maxWidth: 640,
};
const titleStyle: CSSProperties = { fontFamily: FONT.serif, fontSize: 22, fontWeight: 500, margin: 0, letterSpacing: 0 };
const subtitleStyle: CSSProperties = { color: COLORS.body, fontSize: 14.5, lineHeight: 1.55, margin: 0 };
const rowStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  paddingTop: 18,
  borderTop: `1px solid ${COLORS.hairline}`,
};
const rowLabelStyle: CSSProperties = { fontSize: 14.5, fontWeight: 700, color: COLORS.ink };
const rowValueStyle: CSSProperties = { fontSize: 14, color: COLORS.body };
const noteStyle: CSSProperties = { fontFamily: FONT.mono, fontSize: 11.5, color: COLORS.meta };
const changeLinkStyle: CSSProperties = {
  flex: "none",
  background: "none",
  border: "none",
  padding: 0,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 13.5,
  fontWeight: 700,
  color: COLORS.navy,
};
const formStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 12, marginTop: 10 };
const fieldStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontSize: 14, color: COLORS.body };
const timeInputStyle: CSSProperties = {
  fontFamily: FONT.sans,
  fontSize: 14,
  padding: "7px 10px",
  borderRadius: 8,
  border: `1px solid ${COLORS.border}`,
  background: COLORS.surface,
  color: COLORS.ink,
};
const saveButtonStyle: CSSProperties = {
  background: COLORS.navy,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  padding: "9px 18px",
  fontSize: 13.5,
  fontWeight: 700,
  cursor: "pointer",
};
const cancelButtonStyle: CSSProperties = {
  background: "none",
  color: COLORS.body,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 8,
  padding: "9px 16px",
  fontSize: 13.5,
  fontWeight: 700,
  cursor: "pointer",
};
