import { useState } from "react";
import { Form } from "react-router";
import { R, RADIUS } from "./register";
import { Mono, RustButton, RustLink } from "./primitives";
import {
  BriefSection,
  QueueSection,
  HorizonSection,
  MemorySection,
  GoalsSection,
  SettingsSection,
  type Finding,
  type HorizonItem,
  type HorizonWatch,
  type GoalChange,
  type QueueItem,
  type ActionPolicy,
  type ChannelRow,
} from "./sections";
import type {
  Metrics,
  MemoryView,
  Recommendation,
  Goal,
  SuggestedAction,
  ExecutedAction,
} from "./data";

// The 13a app-home shell: nav rail · content (with persistent composer) · right rail.
// Full merchant data flows in via props (the same loader data daily-home.tsx uses today,
// plus computed findings / horizon / queue / goal-changes). Section switching is still
// client-side (useState) — turning the six into real routes (/brief…/settings) is a
// separate, coordinated step (chat 2 owns app._index; see QUESTIONS-FOR-MATT.md).
//
// This does NOT replace daily-home.tsx yet. It renders in the /app-home-13a preview and
// is adopted into app._index only on Matt’s nod (App Store review is in flight).

const JEFE_MARK = (
  <svg viewBox="0 0 64 64" style={{ width: "100%", height: "100%", display: "block" }} aria-hidden="true">
    <rect width="64" height="64" rx="16" fill="#33456b" />
    <path d="M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z" fill="#f8ece7" />
    <circle cx="32" cy="49" r="4.5" fill="#c98a8a" />
  </svg>
);

const NAV: Array<{ id: Section; label: string }> = [
  { id: "brief", label: "Brief" },
  { id: "queue", label: "Queue" },
  { id: "horizon", label: "Horizon" },
  { id: "memory", label: "Memory" },
  { id: "goals", label: "Goals" },
  { id: "settings", label: "Settings" },
];
type Section = "brief" | "queue" | "horizon" | "memory" | "goals" | "settings";

export type AppHome13aProps = {
  storeName: string;
  briefHeadline: string;
  metrics: Metrics;
  memory: MemoryView;
  recommendation: Recommendation;
  suggestedAction: SuggestedAction | null;
  executedActions: ExecutedAction[];
  goals: Goal[];
  findings: Finding[];
  goalChanges: GoalChange[];
  horizonNear: HorizonItem[];
  horizonWatching: HorizonWatch[];
  queue: QueueItem[];
  policies: ActionPolicy[];
  channels: ChannelRow[];
  autonomyLabel: string; // e.g. "Learning" — the rail’s autonomy state
  syncedLabel?: string | null; // "synced 4 min ago" — mono; omitted if unknown (honest)
  founderEmail: string; // real mailto target for feedback + founder contact
  bookingUrl?: string | null; // real Calendly link for "Book a slot"; omitted → email fallback
  changelog: Array<{ id: string; date: string; text: string; tag?: string | null }>;
  // The in-app chat thread (merchant-memory conversation), oldest→newest. Empty
  // until the merchant sends the first message.
  conversation: { messages: Array<{ id: string; role: string; content: string }> };
};

export function AppHome13a(props: AppHome13aProps) {
  const [section, setSection] = useState<Section>("brief");
  const cur = props.metrics?.currency || "GBP";
  const queueWaiting = props.queue.filter((q) => q.state === "needs_you").length;
  const memoryCount = (props.memory?.groups || []).reduce((n, g) => n + g.beliefs.length, 0);

  return (
    <div style={{ minHeight: "100vh", display: "flex", background: R.surface, color: R.ink, fontFamily: R.sans }}>
      {/* NAV */}
      <nav aria-label="Sections" style={{ width: 198, flex: "none", borderRight: `1px solid ${R.divider}`, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 6px" }}>
          <span style={{ width: 22, height: 22, flex: "none", display: "inline-block" }}>{JEFE_MARK}</span>
          <span style={{ fontWeight: 700, fontSize: 14 }}>Jefe</span>
          <span style={{ marginLeft: "auto", fontFamily: R.sans, fontSize: 11.5, color: R.label }}>{props.storeName}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {NAV.map((n) => {
            const active = section === n.id;
            const badge = n.id === "queue" ? queueWaiting : n.id === "memory" ? memoryCount : 0;
            return (
              <button
                key={n.id}
                type="button"
                onClick={() => setSection(n.id)}
                aria-current={active ? "page" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  textAlign: "left",
                  gap: 8,
                  padding: "8px 10px",
                  // active state: 2px rust left-rule + warm background (rule: not a pill)
                  borderLeft: `2px solid ${active ? R.rust : "transparent"}`,
                  background: active ? R.activeNav : "transparent",
                  color: active ? R.ink : R.ink3,
                  fontWeight: active ? 600 : 400,
                  fontFamily: R.sans,
                  fontSize: 13.5,
                  border: "none",
                  borderLeftWidth: 2,
                  borderLeftStyle: "solid",
                  borderLeftColor: active ? R.rust : "transparent",
                  cursor: "pointer",
                }}
              >
                <span>{n.label}</span>
                {badge > 0 ? <span style={{ fontFamily: R.sans, fontWeight: 600, fontVariantNumeric: "tabular-nums", fontSize: 12, color: active ? R.rust : R.label }}>{badge}</span> : null}
              </button>
            );
          })}
        </div>
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 4, padding: "0 8px" }}>
          <span style={{ fontFamily: R.sans, fontSize: 12, color: R.label }}>Autonomy <strong style={{ color: R.ink2, fontWeight: 600 }}>{props.autonomyLabel}</strong></span>
          <button type="button" onClick={() => setSection("settings")} style={{ alignSelf: "flex-start", fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust, background: "none", border: "none", padding: 0, cursor: "pointer" }}>Set his limits</button>
          {props.syncedLabel ? <Mono style={{ fontSize: 10, marginTop: 4 }}>{props.syncedLabel}</Mono> : null}
        </div>
      </nav>

      {/* CONTENT + composer */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${R.divider}` }}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "26px 30px 20px" }}>
          {section === "brief" ? (
            <BriefSection
              metrics={props.metrics}
              memory={props.memory}
              recommendation={props.recommendation}
              suggestedAction={props.suggestedAction}
              executedActions={props.executedActions}
              goals={props.goals}
              findings={props.findings}
              cur={cur}
              headline={props.briefHeadline}
            />
          ) : section === "queue" ? (
            <QueueSection items={props.queue} />
          ) : section === "horizon" ? (
            <HorizonSection near={props.horizonNear} watching={props.horizonWatching} />
          ) : section === "memory" ? (
            <MemorySection storeName={props.storeName} memory={props.memory} />
          ) : section === "goals" ? (
            <GoalsSection goals={props.goals} changes={props.goalChanges} />
          ) : (
            <SettingsSection policies={props.policies} channels={props.channels} />
          )}
        </div>
        {/* composer — real in-app chat with Jefe. Posts chat.message (reusing the
            merchant-memory conversation) and stays on the daily home. */}
        <Composer conversation={props.conversation} />
      </div>

      {/* RIGHT RAIL — persists; first to drop at narrow widths. Feedback is REAL (mailto). */}
      <aside style={{ width: 268, flex: "none", display: "flex", flexDirection: "column", padding: "22px 18px", gap: 24 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: R.sans, fontSize: 13, fontWeight: 700, color: R.ink, paddingBottom: 7, borderBottom: `1px solid ${R.frame}` }}>Tell us what to build</div>
          <div style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3 }}>What’s missing? What’s annoying? Tell us — we’d rather have the mess than a tidy summary.</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* Founder call: this is a CHAT, not an email — it drops the merchant
                into the in-app composer (one conversation with Jefe), where "what
                to build" is captured as intent signal. The human door stays the
                "Talk to the founders" section below. */}
            <button
              type="button"
              onClick={focusComposer}
              style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: "#fdfbf7", background: R.rust, borderRadius: RADIUS.button, padding: "7px 13px", border: "none", cursor: "pointer" }}
            >
              Tell Jefe →
            </button>
            {/* Record: kept visible (founder call) but honestly gated — the upload/
                transcription target is a separate build (chat 10). Not a live no-op. */}
            <span
              aria-disabled="true"
              title="Voice notes are coming soon"
              style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.label, background: "transparent", border: `1px solid ${R.controlBorder}`, borderRadius: RADIUS.button, padding: "6px 12px", cursor: "default" }}
            >
              Record a voice note
              <span style={{ fontFamily: R.mono, fontSize: 9, letterSpacing: "0.5px", textTransform: "uppercase", color: R.metaMono, border: `1px solid ${R.hairline}`, borderRadius: 3, padding: "1px 4px" }}>soon</span>
            </span>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontFamily: R.sans, fontSize: 13, fontWeight: 700, color: R.ink, paddingBottom: 7, borderBottom: `1px solid ${R.frame}` }}>Talk to the founders</div>
          <div style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3 }}>Thirty minutes whenever you need it. We built Jefe and we answer our own email.</div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
            {props.bookingUrl ? (
              <a href={props.bookingUrl} target="_blank" rel="noreferrer" style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: "#fdfbf7", background: R.rust, borderRadius: RADIUS.button, padding: "7px 13px", textDecoration: "none" }}>Book a slot</a>
            ) : null}
            <a href={`mailto:hola@mynamejefe.com?subject=${encodeURIComponent("Jefe — can we talk?")}`} target="_blank" rel="noreferrer" style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust, textDecoration: "none" }}>Email us</a>
          </div>
        </div>

        {props.changelog.length ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontFamily: R.sans, fontSize: 13, fontWeight: 700, color: R.ink, paddingBottom: 7, borderBottom: `1px solid ${R.frame}` }}>New in Jefe</div>
            {props.changelog.slice(0, 3).map((c) => (
              <div key={c.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <Mono style={{ fontSize: 10 }}>{c.date}</Mono>
                <span style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.45, color: R.ink2 }}>{c.text}</span>
                {c.tag ? <span style={{ fontFamily: R.sans, fontSize: 11.5, fontWeight: 600, color: R.rust }}>{c.tag}</span> : null}
              </div>
            ))}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

// Focus (and scroll to) the persistent composer input — lets rail affordances
// ("Tell Jefe →") drop the merchant straight into the in-app chat. No-op during
// SSR / before hydration.
function focusComposer() {
  if (typeof document === "undefined") return;
  const el = document.getElementById("jefe-chat-input");
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.focus();
}

// The persistent composer — real in-app chat with Jefe. The input posts
// chat.message (which reuses the merchant-memory conversation service and
// redirects back here). Keyed on message count so a successful send remounts the
// form and clears the input. The thread (recent messages) expands above the bar.
function Composer({ conversation }: { conversation: AppHome13aProps["conversation"] }) {
  const messages = conversation?.messages ?? [];
  const hasThread = messages.length > 0;
  // Default to showing the thread when one exists, so a reply is visible right
  // after sending; collapsible for merchants who want the bar back.
  const [open, setOpen] = useState(true);
  return (
    <div style={{ flex: "none", borderTop: `1px solid ${R.divider}` }}>
      {hasThread && open ? (
        <div style={{ maxHeight: 260, overflowY: "auto", padding: "14px 30px", display: "flex", flexDirection: "column", gap: 12, borderBottom: `1px solid ${R.hairline}` }}>
          {messages.map((m) => (
            <div key={m.id} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <Mono style={{ fontSize: 10 }}>{m.role === "merchant" ? "You" : "Jefe"}</Mono>
              <span style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: m.role === "merchant" ? R.ink : R.ink2, whiteSpace: "pre-wrap" }}>{m.content}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div style={{ padding: "12px 30px", display: "flex", alignItems: "center", gap: 10 }}>
        {hasThread ? (
          <RustLink onClick={() => setOpen((v) => !v)} style={{ flex: "none" }}>
            {open ? "Hide chat" : `Chat · ${messages.length}`}
          </RustLink>
        ) : null}
        <Form method="post" key={messages.length} style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
          <input type="hidden" name="intent" value="chat.message" />
          <input
            id="jefe-chat-input"
            name="message"
            required
            autoComplete="off"
            aria-label="Message Jefe"
            placeholder="Tell Jefe something, or ask why — he remembers, and a correction from you outranks anything he inferred."
            style={{ flex: 1, minWidth: 0, fontFamily: R.sans, fontSize: 13, padding: "9px 12px", borderRadius: RADIUS.button, border: `1px solid ${R.controlBorder}`, background: R.surface, color: R.ink }}
          />
          <RustButton type="submit">Send</RustButton>
        </Form>
      </div>
    </div>
  );
}
