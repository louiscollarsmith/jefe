import { useState } from "react";

// Real, data-driven Jefe "Daily" home (design screen 5a), rendered post-onboarding
// inside the Shopify admin. Wired to actual merchant data — store metrics, the real
// Plan recommendation, memory beliefs, goals. Where the backend has no real data yet
// (per-decision £ values, day-over-day deltas, executed-action feed, goal progress),
// it shows honest states instead of the design's demo numbers. See
// docs/ops/design_backend_backlog.md for what's still to build.

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

export function DailyHome({
  storeName,
  metrics,
  memory,
  recommendation,
  goals,
}: {
  storeName: string;
  merchantName: string;
  metrics: Metrics;
  memory: MemoryView;
  recommendation: Recommendation;
  insights: Array<{ id: string; title: string; finding: string; confidence: string }>;
  goals: Goal[];
}) {
  const [showWorking, setShowWorking] = useState(false);
  const cur = metrics?.currency || "GBP";
  const beliefs = (memory?.groups || []).flatMap((g) => g.beliefs).slice(0, 5);

  return (
    <div style={{ minHeight: "100vh", display: "flex", background: T.canvas, color: T.ink, fontFamily: "'Schibsted Grotesk', system-ui, sans-serif" }}>
      {/* NAV */}
      <div style={{ width: 198, flex: "none", borderRight: `1px solid ${T.border}`, background: T.nav, padding: "16px 12px", display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 4px" }}>
          <span style={{ width: 24, height: 24, flex: "none", display: "inline-block" }}>{JEFE_MARK}</span>
          <span style={{ fontWeight: 700, fontSize: 14.5 }}>Jefe</span>
          <span style={{ marginLeft: "auto", width: 7, height: 7, borderRadius: "50%", background: "oklch(0.6 0.15 155)" }} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {[
            { l: "Brief", active: true },
            { l: "Queue" },
            { l: "Horizon" },
            { l: "Memory" },
            { l: "Goals" },
            { l: "Settings" },
          ].map((n) => (
            <div key={n.l} style={{ display: "flex", alignItems: "center", padding: "8px 10px", borderRadius: 8, fontSize: 13.5, background: n.active ? T.navyTint : "transparent", color: n.active ? "oklch(0.3 0.06 262)" : "oklch(0.4 0.015 60)", fontWeight: n.active ? 700 : 400 }}>
              {n.l}
            </div>
          ))}
        </div>
      </div>

      {/* BRIEF */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", borderRight: `1px solid ${T.borderSubtle}` }}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "24px 26px 16px", display: "flex", flexDirection: "column", gap: 20 }}>
          {/* header */}
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ fontFamily: T.mono, fontSize: 10.5, letterSpacing: "1.8px", textTransform: "uppercase", color: T.accent }}>{eyebrowDate()} · your brief</div>
            <div style={{ fontFamily: T.serif, fontSize: 32, lineHeight: 1.15, color: "oklch(0.22 0.02 40)" }}>
              Here's where {storeName || "your store"} stands this morning.
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
            <div style={{ ...label, letterSpacing: "1.6px", fontSize: 10 }}>Your call</div>
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
                  <span style={{ fontFamily: T.brand, background: T.accent, color: "oklch(0.97 0.01 80)", fontWeight: 700, fontSize: 13, padding: "9px 18px", borderRadius: 9, cursor: "pointer" }}>Approve</span>
                  <span style={{ fontFamily: T.brand, color: "oklch(0.4 0.015 60)", fontWeight: 700, fontSize: 13, padding: "9px 15px", borderRadius: 9, border: `1px solid ${T.border}` }}>{recommendation.executionSteps?.length || 0} steps</span>
                  <span onClick={() => setShowWorking((v) => !v)} style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: T.accent, cursor: "pointer" }}>How I got this number ›</span>
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
          </div>

          {/* What Jefe knows — real beliefs */}
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ ...label, letterSpacing: "1.6px", fontSize: 10 }}>What Jefe knows about {storeName || "your store"}</div>
            <div style={{ background: "oklch(0.99 0.003 70)", border: `1px solid ${T.border}`, borderRadius: 14, overflow: "hidden" }}>
              {beliefs.length ? (
                beliefs.map((b, i) => (
                  <div key={b.id} style={{ padding: "11px 15px", borderBottom: i < beliefs.length - 1 ? `1px solid ${T.borderSubtle}` : "none", display: "flex", alignItems: "center", gap: 11 }}>
                    <span style={{ flex: 1, fontSize: 12.5, color: "oklch(0.3 0.02 45)" }}>{b.title}{b.value ? ` · ${b.value}` : ""}</span>
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
              <div style={{ ...label, letterSpacing: "1.6px", fontSize: 10 }}>Your goals</div>
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
        </div>

        {/* composer */}
        <div style={{ flex: "none", borderTop: `1px solid ${T.border}`, background: "oklch(0.98 0.004 68)", padding: "12px 26px 14px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 34, height: 34, flex: "none", borderRadius: 10, background: T.accent, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="oklch(0.97 0.01 80)" strokeWidth={2} strokeLinecap="round" style={{ width: 16, height: 16, display: "block" }}>
              <rect x="9" y="2.5" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5V21" />
            </svg>
          </span>
          <span style={{ flex: 1, fontSize: 13, color: T.muted }}>Ask Jefe anything about your store — or tell him what to work on.</span>
        </div>
      </div>

      {/* RAIL — design-partner programme (not merchant data) */}
      <div style={{ width: 300, flex: "none", background: T.rail, display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 16px 20px", display: "flex", flexDirection: "column", gap: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontFamily: T.mono, fontSize: 9.5, letterSpacing: "1.4px", textTransform: "uppercase", color: "oklch(0.4 0.08 262)", background: T.navyTint, padding: "4px 9px", borderRadius: 100 }}>Design partner</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ ...label, fontSize: 10, letterSpacing: "1.5px", color: T.accent }}>Tell us what to build</div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: T.muted }}>What's missing? What's annoying? Tell us — we're building Jefe with you.</div>
              <div style={{ display: "flex", gap: 7 }}>
                <span style={{ flex: 1, textAlign: "center", fontFamily: T.brand, background: T.accent, color: "oklch(0.97 0.01 80)", fontWeight: 700, fontSize: 12.5, padding: 9, borderRadius: 9, cursor: "pointer" }}>Record</span>
                <span style={{ flex: 1, textAlign: "center", fontFamily: T.brand, color: "oklch(0.4 0.015 60)", fontWeight: 700, fontSize: 12.5, padding: 9, borderRadius: 9, border: `1px solid ${T.border}`, cursor: "pointer" }}>Write</span>
              </div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <div style={{ ...label, fontSize: 10, letterSpacing: "1.5px", color: T.accent }}>Talk to the founders</div>
            <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 12, padding: 13, display: "flex", flexDirection: "column", gap: 11 }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.4, color: "oklch(0.4 0.015 60)" }}>30 minutes with us, whenever you need it.</div>
              <span style={{ fontFamily: T.brand, textAlign: "center", background: T.navy, color: "oklch(0.97 0.01 80)", fontWeight: 700, fontSize: 12.5, padding: 10, borderRadius: 9, cursor: "pointer" }}>Book a slot</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function beliefStatus(status: string): string {
  if (status === "merchant_confirmed") return "Confirmed";
  if (status === "merchant_corrected") return "Corrected";
  return "Observed";
}
function horizonLabel(h: string): string {
  if (h === "threeMonths") return "3 months";
  if (h === "sixMonths") return "6 months";
  if (h === "twelveMonths") return "12 months";
  return h;
}
