import { useState } from "react";
import { Form } from "react-router";

// Real, data-driven Jefe "Daily" home (design screen 5a), rendered post-onboarding
// inside the Shopify admin. Wired to actual merchant data — store metrics, the real
// Plan recommendation, memory beliefs, goals. Where the backend has no real data yet
// (per-decision £ values, day-over-day deltas, executed-action feed, goal progress),
// it shows honest states instead of the design's demo numbers. See
// docs/ops/design_backend_backlog.md for what's still to build.
//
// The left nav is a purely front-end, client-side router: clicking a nav item swaps
// the main column between Brief (default) · Queue · Horizon · Memory · Goals · Settings.
// No new routes, no loader changes. Brief is unchanged from the original 5a build; the
// other five sections reuse the same light token object `T` and honest-empty rules.

type Metrics = {
  orders: number;
  products: number;
  variants: number;
  skus: number;
  customers: number;
  revenue: number | null;
  monthlyRevenue: number | null;
  currency: string;
} | null;

type MemoryBelief = { id: string; title: string; value: string; status: string; evidenceSummary: string | null };
type MemoryView = { groups: Array<{ category: string; label: string; beliefs: MemoryBelief[] }> } | null;

type Recommendation = {
  title: string;
  summary: string;
  whyThisAction: string;
  whyNow: string;
  executionSteps: Array<{ title: string; description: string }>;
  confidence: string;
  expectedBenefit: string;
  successSignal: { description: string; timeframe: string; target: string | null } | null;
} | null;

type Goal = { id: string; horizon: string; title: string; description: string | null };
type Insight = { id: string; title: string; finding: string; confidence: string };

type Section = "brief" | "queue" | "horizon" | "memory" | "goals" | "settings";
const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: "brief", label: "Brief" },
  { id: "queue", label: "Queue" },
  { id: "horizon", label: "Horizon" },
  { id: "memory", label: "Memory" },
  { id: "goals", label: "Goals" },
  { id: "settings", label: "Settings" },
];

const T = {
  canvas: "linear-gradient(180deg, oklch(0.985 0.005 70), oklch(0.965 0.007 65))",
  nav: "oklch(0.975 0.004 68)",
  rail: "oklch(0.972 0.005 68)",
  card: "oklch(0.995 0.004 70)",
  border: "oklch(0.88 0.008 62)",
  borderSubtle: "oklch(0.93 0.006 64)",
  ink: "oklch(0.24 0.02 45)",
  muted: "oklch(0.5 0.015 60)",
  accent: "oklch(0.42 0.09 22)",
  accentTint: "oklch(0.93 0.04 20)",
  navy: "oklch(0.35 0.06 262)",
  navyTint: "oklch(0.93 0.025 262)",
  success: "oklch(0.5 0.13 155)",
  hover: "oklch(0.955 0.005 66)",
  serif: "'Instrument Serif', Georgia, serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
  brand: "'Bricolage Grotesque', sans-serif",
};

const JEFE_MARK = (
  <svg viewBox="0 0 64 64" style={{ width: "100%", height: "100%", display: "block" }}>
    <rect width="64" height="64" rx="16" fill="#33456b" />
    <path d="M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z" fill="#f8ece7" />
    <circle cx="32" cy="49" r="4.5" fill="#c98a8a" />
  </svg>
);

function currencySymbol(code: string): string {
  const c = (code || "GBP").toUpperCase();
  if (c === "GBP") return "£";
  if (c === "USD" || c === "CAD" || c === "AUD") return "$";
  if (c === "EUR") return "€";
  return c + " ";
}
function money(n: number | null | undefined, code: string): string {
  if (n == null) return "—";
  return currencySymbol(code) + Math.round(n).toLocaleString("en-GB");
}
function eyebrowDate(): string {
  return new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

const label: React.CSSProperties = { fontFamily: T.mono, fontSize: 9.5, letterSpacing: "1.2px", textTransform: "uppercase", color: "oklch(0.55 0.015 60)" };
const statValue: React.CSSProperties = { fontFamily: T.serif, fontSize: 21 };
const sectionLabel: React.CSSProperties = { ...label, letterSpacing: "1.6px", fontSize: 10 };

// #17 honesty pass: an INERT control style — visibly not-yet-clickable — for
// actions whose backend isn't wired yet. Replaces the dead `cursor: pointer`
// spans that previously looked live, so nothing on the default screen presents
// as a working action (Product Truth: nothing fake may present as working-real).
const inertControl: React.CSSProperties = {
  fontFamily: T.brand,
  fontWeight: 700,
  fontSize: 12.5,
  padding: "8px 14px",
  borderRadius: 9,
  border: `1px solid ${T.borderSubtle}`,
  color: T.muted,
  background: T.hover,
  cursor: "not-allowed",
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};
function SoonTag() {
  return (
    <span
      style={{
        fontFamily: T.mono,
        fontSize: 8.5,
        letterSpacing: "0.6px",
        textTransform: "uppercase",
        color: T.muted,
        border: `1px solid ${T.border}`,
        borderRadius: 4,
        padding: "1px 4px",
      }}
    >
      soon
    </span>
  );
}

export function DailyHome({
  storeName,
  metrics,
  memory,
  recommendation,
  suggestedAction = null,
  insights,
  goals,
}: {
  storeName: string;
  merchantName: string;
  metrics: Metrics;
  memory: MemoryView;
  recommendation: Recommendation;
  suggestedAction?: SuggestedAction | null;
  insights: Insight[];
  goals: Goal[];
}) {
  const [section, setSection] = useState<Section>("brief");
  const cur = metrics?.currency || "GBP";
  // Derive the waiting count from the actual list, never hardcode it.
  const waitingCount = recommendation ? 1 : 0;

  return (
    <div style={{ minHeight: "100vh", display: "flex", background: T.canvas, color: T.ink, fontFamily: "'Schibsted Grotesk', system-ui, sans-serif" }}>
      {/* NAV — client-side section switcher */}
      <div style={{ width: 198, flex: "none", borderRight: `1px solid ${T.border}`, background: T.nav, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 4px" }}>
          <span style={{ width: 24, height: 24, flex: "none", display: "inline-block" }}>{JEFE_MARK}</span>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>Jefe</span>
          <span style={{ marginLeft: "auto", width: 7, height: 7, borderRadius: "50%", background: "oklch(0.6 0.15 155)" }} />
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 2 }} aria-label="Sections">
          {SECTIONS.map((n) => (
            <NavItem
              key={n.id}
              label={n.label}
              active={section === n.id}
              badge={n.id === "queue" ? waitingCount : null}
              onSelect={() => setSection(n.id)}
            />
          ))}
        </nav>
      </div>

      {/* MAIN — switches per active section; composer stays pinned */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${T.borderSubtle}` }}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "24px 26px 16px", display: "flex", flexDirection: "column", gap: 20 }}>
          {section === "brief" ? (
            <BriefContent storeName={storeName} metrics={metrics} memory={memory} recommendation={recommendation} suggestedAction={suggestedAction} goals={goals} cur={cur} />
          ) : section === "queue" ? (
            <QueueSection recommendation={recommendation} insights={insights} waitingCount={waitingCount} />
          ) : section === "horizon" ? (
            <HorizonSection />
          ) : section === "memory" ? (
            <MemorySection storeName={storeName} memory={memory} />
          ) : section === "goals" ? (
            <GoalsSection goals={goals} recommendation={recommendation} />
          ) : (
            <SettingsSection storeName={storeName} />
          )}
        </div>

        {/* composer — chat here isn't wired yet; point to the real channels
            rather than presenting a fake input (#17 honesty pass) */}
        <div style={{ flex: "none", borderTop: `1px solid ${T.border}`, background: "oklch(0.98 0.004 68)", padding: "12px 26px 14px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1, fontSize: 13, color: T.muted }}>Chatting with Jefe here is coming soon — for now, reply to any Jefe email or message him in Slack.</span>
          <SoonTag />
        </div>
      </div>

      {/* RAIL — design-partner programme (not merchant data) */}
      <div style={{ width: 300, flex: "none", background: T.rail, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 16px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "1.4px", textTransform: "uppercase", color: "oklch(0.4 0.08 262)", background: T.navyTint, padding: "4px 9px", borderRadius: 100 }}>Design partner</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ ...sectionLabel, color: T.accent }}>Tell us what to build</div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>What’s missing? What’s annoying? Tell us — we’re building Jefe with you.</div>
              <div style={{ display: "flex", gap: 7 }}>
                <span style={{ ...inertControl, flex: 1, justifyContent: "center" }} aria-disabled="true">Record <SoonTag /></span>
                <span style={{ ...inertControl, flex: 1, justifyContent: "center" }} aria-disabled="true">Write <SoonTag /></span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ ...sectionLabel, color: T.accent }}>Talk to the founders</div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 13, display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.4, color: "oklch(0.4 0.015 60)" }}>30 minutes with us, whenever you need it.</div>
              <span style={{ ...inertControl, justifyContent: "center" }} aria-disabled="true">Book a slot <SoonTag /></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nav + shared interactive controls
// ---------------------------------------------------------------------------

function NavItem({ label: text, active, badge, onSelect }: { label: string; active: boolean; badge: number | null; onSelect: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-current={active ? "page" : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        width: "100%",
        textAlign: "left",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 8,
        fontSize: 13.5,
        fontFamily: "inherit",
        border: "none",
        cursor: "pointer",
        transition: "background 0.14s ease",
        background: active ? T.navyTint : hover ? T.hover : "transparent",
        color: active ? "oklch(0.3 0.06 262)" : "oklch(0.4 0.015 60)",
        fontWeight: active ? 700 : 400,
      }}
    >
      <span>{text}</span>
      {badge != null && badge > 0 ? (
        <span style={{ fontFamily: T.mono, fontSize: 11, color: active ? "oklch(0.4 0.06 262)" : T.muted }}>{badge}</span>
      ) : null}
    </button>
  );
}

function SubTab({ label: text, active, onSelect }: { label: string; active: boolean; onSelect: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-current={active ? "true" : undefined}
      style={{
        fontFamily: T.mono,
        fontSize: 11,
        letterSpacing: "0.8px",
        textTransform: "uppercase",
        padding: "7px 13px",
        borderRadius: 100,
        cursor: "pointer",
        transition: "background 0.14s ease",
        border: `1px solid ${active ? T.border : "transparent"}`,
        background: active ? T.card : hover ? T.hover : "transparent",
        color: active ? T.ink : T.muted,
        fontWeight: active ? 700 : 400,
      }}
    >
      {text}
    </button>
  );
}

function SectionHead({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: "1.8px", textTransform: "uppercase", color: T.accent }}>{eyebrow}</div>
      <div style={{ fontFamily: T.serif, fontSize: 32, lineHeight: 1.15, color: "oklch(0.22 0.02 40)" }}>{title}</div>
      {subtitle ? <div style={{ fontSize: 13, lineHeight: 1.5, color: T.muted, maxWidth: 640 }}>{subtitle}</div> : null}
    </div>
  );
}

function ScopePill({ acts }: { acts?: boolean }) {
  return (
    <span
      style={{
        fontFamily: T.mono,
        fontSize: 9,
        letterSpacing: "0.6px",
        textTransform: "uppercase",
        padding: "3px 7px",
        borderRadius: 5,
        whiteSpace: "nowrap",
        color: acts ? "oklch(0.4 0.08 20)" : "oklch(0.38 0.07 262)",
        background: acts ? T.accentTint : T.navyTint,
      }}
    >
      {acts ? "Reads & acts" : "Reads"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// BRIEF (default) — unchanged from the original 5a build
// ---------------------------------------------------------------------------

// A GENERIC "action Jefe suggests" advisory card. Renders ANY action the LLM
// proposes from memory (dead-stock clearance is the first thing through it, but
// this is deliberately NOT bound to any per-action shaper — one action ontology,
// per the autonomy-from-install direction). `executable:false` (execution still
// dark) → advisory only, NO live Approve button (honest, the #17 principle).
// `executable:true` → the real Approve→execute trigger appears; the route
// `action.approve` handler + the typed reversible adapter that actually changes
// the store is the execution lane (chat 4) — the shape's execute contract
// (intent + action reference) is finalised with that binding.
export type SuggestedAction = {
  headline: string;
  keyNumbers?: Array<{ label: string; value: string }>;
  topItems?: Array<{ title: string; detail?: string }>;
  executable: boolean;
};

function SuggestedActionCard({ action }: { action: SuggestedAction }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.navy}`, borderRadius: 15, padding: "15px 17px", display: "flex", flexDirection: "column", gap: 9 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "1.1px", textTransform: "uppercase", fontWeight: 500, color: "oklch(0.4 0.08 262)", background: T.navyTint, padding: "3px 7px", borderRadius: 5 }}>Jefe suggests</span>
      </div>
      <div style={{ fontSize: 15, lineHeight: 1.4, color: T.ink, fontWeight: 600 }}>{action.headline}</div>
      {action.keyNumbers?.length ? (
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          {action.keyNumbers.map((n) => (
            <div key={n.label}>
              <div style={label}>{n.label}</div>
              <div style={{ fontFamily: T.serif, fontSize: 18 }}>{n.value}</div>
            </div>
          ))}
        </div>
      ) : null}
      {action.topItems?.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {action.topItems.slice(0, 3).map((it, i) => (
            <div key={i} style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>
              <strong style={{ color: T.ink }}>{it.title}</strong>
              {it.detail ? ` — ${it.detail}` : ""}
            </div>
          ))}
        </div>
      ) : null}
      {action.executable ? (
        <div style={{ marginTop: 2 }}>
          <Form method="post">
            <input type="hidden" name="intent" value="action.approve" />
            <button type="submit" style={{ fontFamily: T.brand, background: T.navy, color: "oklch(0.97 0.01 80)", fontWeight: 700, fontSize: 13, padding: "9px 18px", borderRadius: 9, border: "none", cursor: "pointer" }}>Approve →</button>
          </Form>
        </div>
      ) : (
        <div style={{ fontSize: 12, lineHeight: 1.5, color: T.muted, fontStyle: "italic" }}>
          Advisory for now — Jefe will action this for you once execution is switched on.
        </div>
      )}
    </div>
  );
}

function BriefContent({
  storeName,
  metrics,
  memory,
  recommendation,
  suggestedAction,
  goals,
  cur,
}: {
  storeName: string;
  metrics: Metrics;
  memory: MemoryView;
  recommendation: Recommendation;
  suggestedAction: SuggestedAction | null;
  goals: Goal[];
  cur: string;
}) {
  const [showWorking, setShowWorking] = useState(false);
  const beliefs = (memory?.groups || []).flatMap((g) => g.beliefs).slice(0, 5);

  return (
    <>
      {/* header */}
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: "1.8px", textTransform: "uppercase", color: T.accent }}>{eyebrowDate()} · your brief</div>
        <div style={{ fontFamily: T.serif, fontSize: 32, lineHeight: 1.15, color: "oklch(0.22 0.02 40)" }}>
          Here’s where {storeName || "your store"} stands this morning.
        </div>
        <div style={{ display: "flex", gap: 20, marginTop: 2, flexWrap: "wrap" }}>
          <div><div style={label}>Orders</div><div style={statValue}>{metrics ? metrics.orders.toLocaleString("en-GB") : "—"}</div></div>
          <div><div style={label}>Revenue · 30d</div><div style={statValue}>{money(metrics?.monthlyRevenue, cur)}</div></div>
          <div><div style={label}>Customers</div><div style={statValue}>{metrics ? metrics.customers.toLocaleString("en-GB") : "—"}</div></div>
          <div><div style={label}>Products</div><div style={statValue}>{metrics ? metrics.products.toLocaleString("en-GB") : "—"}</div></div>
        </div>
      </div>

      {/* Your call — real recommendation */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={sectionLabel}>Your call</div>
        {recommendation ? (
          <div style={{ background: T.card, border: `1px solid oklch(0.62 0.13 22)`, borderRadius: 15, padding: "15px 17px", display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "1.1px", textTransform: "uppercase", fontWeight: 500, color: "oklch(0.4 0.08 20)", background: T.accentTint, padding: "3px 7px", borderRadius: 5 }}>Needs your OK</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted }}>confidence: {recommendation.confidence}</span>
            </div>
            <div style={{ fontSize: 15, lineHeight: 1.4, color: T.ink, fontWeight: 600 }}>{recommendation.title}</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>{recommendation.whyThisAction || recommendation.summary}</div>
            {recommendation.expectedBenefit ? (
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: "oklch(0.36 0.11 155)" }}>{recommendation.expectedBenefit}</div>
            ) : null}
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2, flexWrap: "wrap" }}>
              <span style={inertControl} aria-disabled="true" title="Approvals are coming soon">Approve <SoonTag /></span>
              <span style={{ fontFamily: T.brand, color: "oklch(0.4 0.015 60)", fontWeight: 700, fontSize: 13, padding: "9px 15px", borderRadius: 9, border: `1px solid ${T.border}` }}>{recommendation.executionSteps?.length || 0} steps</span>
              <button type="button" onClick={() => setShowWorking((v) => !v)} style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: T.accent, cursor: "pointer", background: "none", border: "none", padding: 0, fontFamily: "inherit" }}>How I got this number ›</button>
            </div>
            {showWorking ? (
              <div style={{ background: "oklch(0.975 0.005 68)", borderRadius: 10, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.ink }}><strong>Why now:</strong> {recommendation.whyNow || "—"}</div>
                {recommendation.successSignal ? (
                  <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}><strong>Success signal:</strong> {recommendation.successSignal.description} {recommendation.successSignal.target ? `(${recommendation.successSignal.target})` : ""} · {recommendation.successSignal.timeframe}</div>
                ) : null}
                {recommendation.executionSteps?.length ? (
                  <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
                    {recommendation.executionSteps.map((s, i) => (
                      <li key={i} style={{ fontSize: 12.5, lineHeight: 1.5, color: T.ink }}><strong>{s.title}</strong>{s.description ? ` — ${s.description}` : ""}</li>
                    ))}
                  </ol>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 15, padding: "15px 17px", fontSize: 13.5, lineHeight: 1.5, color: T.muted }}>
            No move waiting on you right now — Jefe is lining up your next recommendation from the latest data.
          </div>
        )}
        {suggestedAction ? <SuggestedActionCard action={suggestedAction} /> : null}
      </div>

      {/* What Jefe knows — real beliefs */}
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={sectionLabel}>What Jefe knows about {storeName || "your store"}</div>
        <div style={{ background: "oklch(0.99 0.003 70)", border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
          {beliefs.length ? (
            beliefs.map((b, i) => (
              <div key={b.id} style={{ padding: "11px 15px", borderBottom: i < beliefs.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", alignItems: "center", gap: 11 }}>
                <span style={{ flex: 1, fontSize: 12.5, color: "oklch(0.3 0.02 45)" }}>{b.title}{cleanBeliefValue(b.value) ? ` · ${cleanBeliefValue(b.value)}` : ""}</span>
                <span style={{ flex: "none", fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>{beliefStatus(b.status)}</span>
              </div>
            ))
          ) : (
            <div style={{ padding: "13px 15px", fontSize: 12.5, color: T.muted }}>Jefe is still reading your store — the first things he learns will appear here.</div>
          )}
        </div>
      </div>

      {/* Goals — real horizons (text, no fabricated progress) */}
      {goals && goals.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={sectionLabel}>Your goals</div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {goals.map((g) => (
              <div key={g.id} style={{ flex: "1 1 180px", background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 14 }}>
                <div style={{ ...label, fontSize: 9.5, color: T.accent }}>{horizonLabel(g.horizon)}</div>
                <div style={{ fontFamily: T.serif, fontSize: 18, marginTop: 6, lineHeight: 1.2 }}>{g.title}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// QUEUE — the real recommendation as a waiting/handled/declined list, or 7c zero-state
// ---------------------------------------------------------------------------

function QueueSection({ recommendation, insights, waitingCount }: { recommendation: Recommendation; insights: Insight[]; waitingCount: number }) {
  if (!recommendation) {
    // 7c: queue-at-zero is a reward, not an empty box.
    const watching = insights.slice(0, 4);
    return (
      <>
        <SectionHead eyebrow="Your queue" title="Nothing needs you." subtitle="You’re all clear — nothing in the queue is waiting on a decision right now. Jefe keeps working in the background and will bring the next move when it’s worth your time." />
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={sectionLabel}>What Jefe’s watching</div>
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
            {watching.length ? (
              watching.map((it, i) => (
                <div key={it.id} style={{ padding: "12px 15px", borderBottom: i < watching.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", alignItems: "center", gap: 11 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.navy, flex: "none" }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5, color: "oklch(0.3 0.02 45)" }}>{it.finding || it.title}</span>
                  <span style={{ flex: "none", fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>{it.confidence}</span>
                </div>
              ))
            ) : (
              ["Returns and the reasons behind them", "Repeat-purchase timing", "Inventory that could run short", "Ad spend that stops paying back"].map((area, i, arr) => (
                <div key={area} style={{ padding: "12px 15px", borderBottom: i < arr.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", alignItems: "center", gap: 11 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.navy, flex: "none" }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.5, color: "oklch(0.3 0.02 45)" }}>{area}</span>
                  <span style={{ flex: "none", fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>watching</span>
                </div>
              ))
            )}
          </div>
        </div>
      </>
    );
  }

  const rec = recommendation;
  const tag = queueValueTag(rec);
  const steps = rec.executionSteps?.length || 0;

  return (
    <>
      <SectionHead eyebrow="Your queue" title="Here’s what’s waiting on you." />

      {/* counters — waiting derived from the list; handled/declined honestly empty for now */}
      <div style={{ display: "flex", gap: 26, flexWrap: "wrap" }}>
        <div><div style={label}>Waiting</div><div style={statValue}>{waitingCount}</div></div>
        <div><div style={label}>Handled</div><div style={{ ...statValue, color: T.muted }}>0</div></div>
        <div><div style={label}>Declined</div><div style={{ ...statValue, color: T.muted }}>0</div></div>
      </div>
      <div style={{ fontSize: 12, color: T.muted, marginTop: -8 }}>Handled and declined fill in as you and Jefe work the queue — a decline always carries a reason, and that reason is how Jefe learns.</div>

      {/* the waiting row */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
        <div style={{ padding: "14px 16px", display: "flex", alignItems: "flex-start", gap: 14 }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "1px", textTransform: "uppercase", color: "oklch(0.3 0.06 262)", background: T.navyTint, padding: "3px 8px", borderRadius: 5 }}>Waiting</span>
              <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "1px", textTransform: "uppercase", color: "oklch(0.4 0.08 20)", background: T.accentTint, padding: "3px 8px", borderRadius: 5 }}>Needs your OK</span>
              <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>found by Jefe · Plan</span>
            </div>
            <div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.4, color: T.ink }}>{rec.title}</div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>{rec.whyThisAction || rec.summary}</div>
          </div>
          <div style={{ flex: "none", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 7, maxWidth: 150 }}>
            {tag.kind === "benefit" ? (
              <span style={{ fontFamily: T.serif, fontSize: 16, lineHeight: 1.2, color: T.accent, textAlign: "right" }}>{tag.text}</span>
            ) : (
              <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "0.5px", textTransform: "uppercase", color: T.muted, background: T.hover, padding: "4px 8px", borderRadius: 6, whiteSpace: "nowrap" }}>{tag.text}</span>
            )}
            <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>{steps} steps</span>
          </div>
        </div>
        <div style={{ borderTop: `1px solid ${T.borderSubtle}`, padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={inertControl} aria-disabled="true">Approve <SoonTag /></span>
          <span style={inertControl} aria-disabled="true">Decline <SoonTag /></span>
          <span style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: T.muted }}>Full reasoning in the Brief</span>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// HORIZON — forward-looking seasonal timeline. Dates are computed (never hardcoded);
// everything else is a clearly-framed preview of a tomorrow-backend surface.
// ---------------------------------------------------------------------------

function HorizonSection() {
  const now = new Date();
  const timeline = buildHorizon(now);

  return (
    <>
      <SectionHead eyebrow="Horizon" title="What’s coming — and when to move." subtitle="These are real seasonal dates worked out for your calendar. Jefe will wire them to your stock levels, supplier lead times and inbox next; for now this is a preview." />

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {timeline.map((e) => (
          <div key={e.key} style={{ background: T.card, border: `1px solid ${e.urgent ? "oklch(0.62 0.13 22)" : T.border}`, borderRadius: 14, padding: "14px 16px", display: "flex", gap: 14, alignItems: "flex-start" }}>
            <div style={{ flex: "none", width: 92, display: "flex", flexDirection: "column", gap: 2 }}>
              <div style={{ fontFamily: T.serif, fontSize: 19, lineHeight: 1.1, color: "oklch(0.22 0.02 40)" }}>{e.dateLabel}</div>
              <div style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted }}>in ~{e.weeks} {e.weeks === 1 ? "week" : "weeks"}</div>
            </div>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: T.ink }}>{e.title}</span>
                {e.urgent ? (
                  <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: "1px", textTransform: "uppercase", color: "oklch(0.4 0.08 20)", background: T.accentTint, padding: "2px 7px", borderRadius: 5 }}>Plan this now</span>
                ) : null}
              </div>
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>{e.note}</div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: e.urgent ? T.accent : T.muted }}>Prep window opens {e.prepLabel}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <div style={sectionLabel}>Outside your store</div>
        <div style={{ background: "oklch(0.99 0.003 70)", border: `1px dashed ${T.border}`, borderRadius: 14, padding: "15px 17px", display: "flex", flexDirection: "column", gap: 7 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.ink }}>Coming soon</div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: T.muted }}>Supplier price changes spotted in your inbox, competitor moves on products you actually overlap on, and weather that shifts demand — each tied to a specific SKU, never general news. Jefe only raises an outside event when it lands on something in your store.</div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// MEMORY — the real belief file, grouped by category; teaching sections stay named
// even when empty (design 10b / 3a).
// ---------------------------------------------------------------------------

const MEMORY_TEACHING: Array<{ key: string; label: string; hint: string }> = [
  { key: "people", label: "People & approvals", hint: "Who can approve what, and how far each person’s spend limit goes." },
  { key: "guardrails", label: "Constraints & guardrails", hint: "The lines Jefe won’t cross — budget caps, tone, the things to always check first." },
  { key: "corrections", label: "Learned from your corrections", hint: "When you tell Jefe he got something wrong, the fix lives here so it never comes back." },
];

function MemorySection({ storeName, memory }: { storeName: string; memory: MemoryView }) {
  const groups = (memory?.groups || []).filter((g) => g.beliefs.length > 0);
  const total = groups.reduce((n, g) => n + g.beliefs.length, 0);

  return (
    <>
      <SectionHead
        eyebrow="Memory"
        title={`What Jefe knows about ${storeName || "your store"}.`}
        subtitle={total > 0 ? "This is a file, not a feed — everything Jefe has learned, where it came from, and whether you’ve confirmed it. Most stores end up around fifty entries, so yours is still early." : "This is a file, not a feed. It fills up as Jefe reads your store and as you talk to him — most stores end up around fifty entries."}
      />

      {groups.map((g) => (
        <div key={g.category} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={sectionLabel}>{g.label}</div>
          <div style={{ background: "oklch(0.99 0.003 70)", border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
            {g.beliefs.map((b, i) => {
              const value = cleanBeliefValue(b.value);
              return (
                <div key={b.id} style={{ padding: "11px 15px", borderBottom: i < g.beliefs.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", alignItems: "center", gap: 11 }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "oklch(0.3 0.02 45)" }}>{b.title}{value ? ` · ${value}` : ""}</span>
                  <span style={{ flex: "none", fontFamily: T.mono, fontSize: 9.5, color: beliefStatusColor(b.status) }}>{beliefStatus(b.status)}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {MEMORY_TEACHING.map((t) => (
        <div key={t.key} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={sectionLabel}>{t.label} — nothing here yet</div>
          <div style={{ background: "oklch(0.99 0.003 70)", border: `1px dashed ${T.border}`, borderRadius: 14, padding: "12px 15px", fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>{t.hint}</div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// GOALS — real 3/6/12-month horizons as cards; honest "not started", no fake progress
// ---------------------------------------------------------------------------

function GoalsSection({ goals, recommendation }: { goals: Goal[]; recommendation: Recommendation }) {
  if (!goals || goals.length === 0) {
    return (
      <>
        <SectionHead eyebrow="Goals" title="No direction set yet." subtitle="Goals are where you tell Jefe what winning looks like at 3, 6 and 12 months. Set them during onboarding, or just tell Jefe in chat and he’ll draft them with you." />
      </>
    );
  }

  const ordered = [...goals].sort((a, b) => horizonRank(a.horizon) - horizonRank(b.horizon));

  return (
    <>
      <SectionHead eyebrow="Goals" title="Where we’re heading." subtitle="The direction Jefe measures every move against. Status and progress start tracking once he’s working moves against each one." />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        {ordered.map((g) => (
          <div key={g.id} style={{ flex: "1 1 220px", minWidth: 0, background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ ...label, fontSize: 9.5, color: T.accent }}>{horizonLabel(g.horizon)}</span>
              <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 9, letterSpacing: "0.6px", textTransform: "uppercase", color: T.muted, background: T.hover, padding: "3px 8px", borderRadius: 100 }}>Not started</span>
            </div>
            <div style={{ fontFamily: T.serif, fontSize: 21, lineHeight: 1.2, color: "oklch(0.22 0.02 40)" }}>{g.title}</div>
            {g.description ? <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>{g.description}</div> : null}
          </div>
        ))}
      </div>

      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted, background: "oklch(0.99 0.003 70)", border: `1px dashed ${T.border}`, borderRadius: 12, padding: "12px 15px" }}>
        {recommendation
          ? "Once Jefe can trace each open move to the goal it serves, you’ll see which goals are moving and which have nothing working for them — a goal with no moves against it is worth surfacing."
          : "As moves start flowing, each one gets traced to the goal it serves, so you can see which goals are actually progressing."}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// SETTINGS — Team · Integrations · Developer · Data (sub-tab switch via useState).
// Placeholder content, but intentional and clickable.
// ---------------------------------------------------------------------------

type SettingsTab = "team" | "integrations" | "developer" | "data";

function SettingsSection({ storeName }: { storeName: string }) {
  const [tab, setTab] = useState<SettingsTab>("team");

  return (
    <>
      <SectionHead eyebrow="Settings" title="How Jefe runs for you." />

      <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
        {([
          { id: "team", label: "Team" },
          { id: "integrations", label: "Integrations" },
          { id: "developer", label: "Developer" },
          { id: "data", label: "Data" },
        ] as Array<{ id: SettingsTab; label: string }>).map((t) => (
          <SubTab key={t.id} label={t.label} active={tab === t.id} onSelect={() => setTab(t.id)} />
        ))}
      </div>

      {tab === "team" ? <SettingsTeam /> : tab === "integrations" ? <SettingsIntegrations storeName={storeName} /> : tab === "developer" ? <SettingsDeveloper /> : <SettingsData storeName={storeName} />}
    </>
  );
}

function SettingRow({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: "12px 15px", borderBottom: `1px solid ${T.borderSubtle}`, display: "flex", alignItems: "center", gap: 12 }}>{children}</div>;
}
function SettingCard({ children }: { children: React.ReactNode }) {
  return <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>{children}</div>;
}

function SettingsTeam() {
  const roles = [
    { name: "Owner", limit: "No limit", who: "you" },
    { name: "Approver", limit: "Up to £25k", who: "not set" },
    { name: "Operator", limit: "Up to £500", who: "not set" },
    { name: "Viewer", limit: "Read-only", who: "not set" },
  ];
  return (
    <>
      <div style={{ ...sectionLabel }}>Roles &amp; spend limits</div>
      <SettingCard>
        {roles.map((r, i) => (
          <div key={r.name} style={{ padding: "12px 15px", borderBottom: i < roles.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: T.ink }}>{r.name}</span>
            <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted }}>{r.limit}</span>
            <span style={{ fontFamily: T.mono, fontSize: 9.5, color: T.muted, minWidth: 56, textAlign: "right" }}>{r.who}</span>
          </div>
        ))}
      </SettingCard>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>Team roles, spend limits and routing rules — “over £5k, ask Nadia then tell Sam”, “pricing always goes to Sam”, “urgent on WhatsApp, not Slack” — are coming soon. When they land, roles will be enforced server-side.</div>
      <div><span style={inertControl} aria-disabled="true">Invite a teammate <SoonTag /></span></div>
    </>
  );
}

function SettingsIntegrations({ storeName }: { storeName: string }) {
  const suggested = [
    { name: "Xero", why: "When Jefe can't see your true costs it has to estimate margin — Xero closes that gap." },
    { name: "Gmail", why: "Supplier price changes and delays usually land in your inbox first." },
  ];
  const addZones = [
    { job: "Email", tools: "Gmail · Outlook" },
    { job: "Files & docs", tools: "Drive · OneDrive · Dropbox · Notion" },
    { job: "Accounting", tools: "Xero · QuickBooks" },
    { job: "Reviews", tools: "Trustpilot · Okendo · Judge.me" },
  ];
  return (
    <>
      <div style={sectionLabel}>Working now</div>
      <SettingCard>
        <SettingRow>
          <span style={{ width: 30, height: 30, flex: "none", borderRadius: 8, background: "oklch(0.94 0.06 155)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 14, color: "oklch(0.4 0.13 155)" }}>S</span>
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: T.ink }}>Shopify<span style={{ fontWeight: 400, color: T.muted }}> · {storeName || "your store"}</span></span>
          <ScopePill />
        </SettingRow>
        <div style={{ padding: "10px 15px", fontSize: 12, color: T.muted }}>Auto-detecting the apps already on your store is coming soon — for now, add the ones you want Jefe to read below.</div>
      </SettingCard>

      <div style={sectionLabel}>Jefe suggests</div>
      <SettingCard>
        {suggested.map((s, i) => (
          <div key={s.name} style={{ padding: "13px 15px", borderBottom: i < suggested.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", flexDirection: "column", gap: 7 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.ink }}>{s.name}</span>
              <ScopePill />
              <span style={{ ...inertControl, marginLeft: "auto" }} aria-disabled="true">Connect <SoonTag /></span>
            </div>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>{s.why}</div>
          </div>
        ))}
      </SettingCard>

      <div style={sectionLabel}>Add something else</div>
      <SettingCard>
        {addZones.map((z, i) => (
          <div key={z.job} style={{ padding: "11px 15px", borderBottom: i < addZones.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ flex: "none", width: 96, fontSize: 12.5, fontWeight: 600, color: T.ink }}>{z.job}</span>
            <span style={{ flex: 1, fontSize: 12, color: T.muted }}>{z.tools}</span>
          </div>
        ))}
      </SettingCard>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: T.muted }}>Every integration reads first. Acting is a separate, explicit upgrade per tool — never bundled into the connect. Grouped by job, not vendor, so the list never becomes a wall of logos.</div>
    </>
  );
}

function SettingsDeveloper() {
  return (
    <>
      <div style={sectionLabel}>MCP server</div>
      <SettingCard>
        <div style={{ padding: "13px 15px", display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>An MCP server for Jefe is coming soon — you’ll point any MCP-aware client at it like this:</div>
          <div style={{ fontFamily: T.mono, fontSize: 11.5, color: T.ink, background: "oklch(0.965 0.005 68)", border: `1px solid ${T.borderSubtle}`, borderRadius: 8, padding: "10px 12px", overflowX: "auto", whiteSpace: "nowrap" }}>claude mcp add jefe --url https://mcp.jefe.app</div>
        </div>
      </SettingCard>

      <div style={sectionLabel}>Tools exposed</div>
      <SettingCard>
        {[
          { t: "read_memory", d: "Everything Jefe knows, with provenance" },
          { t: "list_recommendations", d: "The current queue" },
          { t: "get_metrics", d: "Store metrics Jefe works from" },
        ].map((row, i, arr) => (
          <div key={row.t} style={{ padding: "11px 15px", borderBottom: i < arr.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontFamily: T.mono, fontSize: 11.5, color: T.ink, flex: "none" }}>{row.t}</span>
            <span style={{ fontSize: 12, color: T.muted, flex: 1, minWidth: 0 }}>{row.d}</span>
            <ScopePill />
          </div>
        ))}
      </SettingCard>

      <div style={sectionLabel}>API keys</div>
      <SettingCard>
        <div style={{ padding: "13px 15px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ flex: 1, fontSize: 12.5, color: T.muted }}>No keys yet. A key can never do more than the person who created it.</span>
          <span style={inertControl} aria-disabled="true">Create key <SoonTag /></span>
        </div>
      </SettingCard>
    </>
  );
}

function SettingsData({ storeName }: { storeName: string }) {
  const actions = [
    { name: "Export everything", detail: "Every belief, recommendation and message as Markdown — including the Memory file.", cta: "Export .md" },
    { name: "Pause Jefe", detail: "Jefe stops acting and messaging. Your data stays; nothing is lost.", cta: "Pause" },
    { name: "Unsubscribe", detail: "End your plan. Jefe keeps your Memory file in case you come back.", cta: "Unsubscribe" },
    { name: "Delete everything", detail: "Permanently remove all Jefe data for this store. This cannot be undone.", cta: "Delete", danger: true },
  ];
  return (
    <>
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>Your data for {storeName || "your store"} is stored in the EU and never used to train models. Export, pause, leave and delete are coming soon — to remove Jefe now, uninstall the app from your Shopify admin.</div>
      <SettingCard>
        {actions.map((a, i) => (
          <div key={a.name} style={{ padding: "13px 15px", borderBottom: i < actions.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: a.danger ? T.accent : T.ink }}>{a.name}</span>
              <span style={{ fontSize: 12, lineHeight: 1.5, color: T.muted }}>{a.detail}</span>
            </div>
            <span style={{ ...inertControl, flex: "none" }} aria-disabled="true">{a.cta} <SoonTag /></span>
          </div>
        ))}
      </SettingCard>
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Defensive: only surface short, human-readable belief values. The loader already
// suppresses structured/JSON values, but never let a blob or an over-long string
// through into the belief rows.
function cleanBeliefValue(value: string | null | undefined): string {
  if (!value) return "";
  const v = value.trim();
  if (v.startsWith("{") || v.startsWith("[")) return "";
  if (v.length > 48) return "";
  return v;
}

function beliefStatus(status: string): string {
  if (status === "merchant_confirmed") return "Confirmed";
  if (status === "merchant_corrected") return "Corrected";
  return "Observed";
}
function beliefStatusColor(status: string): string {
  if (status === "merchant_confirmed") return T.success;
  if (status === "merchant_corrected") return T.accent;
  return T.muted;
}
function horizonLabel(h: string): string {
  if (h === "threeMonths") return "3 months";
  if (h === "sixMonths") return "6 months";
  if (h === "twelveMonths") return "12 months";
  return h;
}
function horizonRank(h: string): number {
  if (h === "threeMonths") return 0;
  if (h === "sixMonths") return 1;
  if (h === "twelveMonths") return 2;
  return 3;
}
// Queue money slot. There's no per-decision £ model yet, so never show a number here:
// prefer the model's own qualitative benefit (only when it carries no digits, so it can't
// read as false precision), otherwise say plainly that the value isn't priced yet.
function queueValueTag(rec: NonNullable<Recommendation>): { kind: "benefit" | "none"; text: string } {
  const b = (rec.expectedBenefit || "").trim();
  if (b && !/\d/.test(b) && b.length <= 46) return { kind: "benefit", text: b };
  return { kind: "none", text: "No £ figure yet" };
}

// Seasonal timeline. Dates are computed from `now`, never hardcoded — a wrong seasonal
// date destroys the credibility this surface exists to build.
type HorizonEntry = { key: string; title: string; date: Date; prep: Date; note: string; dateLabel: string; prepLabel: string; weeks: number; urgent: boolean };

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): Date {
  const first = new Date(year, month, 1);
  const shift = (weekday - first.getDay() + 7) % 7;
  return new Date(year, month, 1 + shift + (n - 1) * 7);
}
function blackFridayFor(year: number): Date {
  const thanksgiving = nthWeekdayOfMonth(year, 10, 4, 4); // 4th Thursday of November
  return new Date(year, 10, thanksgiving.getDate() + 1);
}
function rollForward(now: Date, build: (year: number) => Date): Date {
  const y = now.getFullYear();
  const candidate = build(y);
  return candidate.getTime() < now.getTime() ? build(y + 1) : candidate;
}
function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

function buildHorizon(now: Date): HorizonEntry[] {
  const DAY = 86400000;
  const raw: Array<{ key: string; title: string; date: Date; prepDays: number; note: string }> = [
    {
      key: "back-to-school",
      title: "Back-to-school demand",
      date: rollForward(now, (y) => new Date(y, 8, 1)),
      prepDays: 28,
      note: "Routine-building season for skincare. Stock and bundle decisions want to be set about a month out.",
    },
    {
      key: "bfcm",
      title: "Black Friday / Cyber weekend",
      date: rollForward(now, blackFridayFor),
      prepDays: 63,
      note: "Your biggest weekend. Supplier lead times run roughly nine weeks, so the real decisions land in early autumn — not the week before.",
    },
    {
      key: "christmas",
      title: "Christmas last-order cut-off",
      date: rollForward(now, (y) => new Date(y, 11, 20)),
      prepDays: 42,
      note: "The last date customers can order and still get it in time. Carrier cut-offs and stock buffers need setting well ahead.",
    },
    {
      key: "returns",
      title: "January returns wave",
      date: rollForward(now, (y) => new Date(y, 0, 6)),
      prepDays: 14,
      note: "The post-holiday returns spike. Worth deciding your returns and win-back approach before it arrives.",
    },
  ];

  return raw
    .map((e) => {
      const prep = new Date(e.date.getTime() - e.prepDays * DAY);
      const weeks = Math.max(0, Math.round((e.date.getTime() - now.getTime()) / (7 * DAY)));
      const urgent = prep.getTime() <= now.getTime() + 21 * DAY;
      return { key: e.key, title: e.title, date: e.date, prep, note: e.note, dateLabel: dayLabel(e.date), prepLabel: dayLabel(prep), weeks, urgent };
    })
    .sort((a, b) => a.date.getTime() - b.date.getTime());
}
