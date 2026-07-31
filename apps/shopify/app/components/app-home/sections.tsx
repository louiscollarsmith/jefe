import { useState } from "react";
import { Form } from "react-router";
import { R, RADIUS, money, figureDisplay } from "./register";
import {
  SectionHeader,
  Row,
  AuthorshipRule,
  SourceLine,
  Mono,
  KeyHint,
  RustButton,
  GhostButton,
  RustLink,
} from "./primitives";
import {
  toMemoryGroups,
  memoryCounts,
  type Metrics,
  type MemoryView,
  type Recommendation,
  type Goal,
  type SuggestedAction,
  type ActionMode,
  type ExecutedAction,
  type MemoryEntry,
} from "./data";

// The six 13a sections. Presentational + the real wired clearance forms (intents
// action.approve / action.reject / action.edit / action.set_mode — carried over
// verbatim from daily-home.tsx so the LIVE clearance loop is unchanged). Actions that
// are NOT yet wired (Memory confirm/edit/forget, Teach Jefe, feedback, Book a slot)
// are built to the design but must be wired (chat 9 for memory, a real Calendly/upload
// for the rail) BEFORE this replaces the live home — tracked in QUESTIONS-FOR-MATT.md.

// ── shared bits ────────────────────────────────────────────────────────────────

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 74 }}>
      <span style={{ fontFamily: R.sans, fontSize: 11.5, color: R.label }}>{label}</span>
      <span style={{ ...figureDisplay, fontSize: 22, lineHeight: 1 }}>{value}</span>
    </div>
  );
}

function DisplayHeadline({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: R.serif, fontSize: 30, lineHeight: 1.12, color: R.ink }}>{children}</div>;
}

// ── the per-action autonomy dial (WIRED: action.set_mode → setActionMode) ─────────
const MODE_OPTIONS: Array<{ value: ActionMode; label: string; hint: string }> = [
  { value: "recommend", label: "Recommend", hint: "Jefe suggests, you do it" },
  { value: "approve_execute", label: "Approve", hint: "Jefe does it once you approve" },
  { value: "autonomous", label: "Auto", hint: "Jefe does it, then tells you" },
];

function ModePicker({ actionType, current, compact = false }: { actionType: string; current: ActionMode; compact?: boolean }) {
  return (
    <Form method="post" style={{ display: "inline-flex" }}>
      <input type="hidden" name="intent" value="action.set_mode" />
      <input type="hidden" name="actionType" value={actionType} />
      <div style={{ display: "inline-flex", border: `1px solid ${R.controlBorder}`, borderRadius: RADIUS.button, overflow: "hidden" }}>
        {MODE_OPTIONS.map((opt, i) => {
          const active = opt.value === current;
          return (
            <button
              key={opt.value}
              type="submit"
              name="mode"
              value={opt.value}
              title={opt.hint}
              aria-pressed={active}
              style={{
                fontFamily: R.sans,
                fontSize: compact ? 11.5 : 12.5,
                fontWeight: 600,
                padding: compact ? "5px 11px" : "6px 14px",
                border: "none",
                borderLeft: i > 0 ? `1px solid ${R.controlBorder}` : "none",
                cursor: "pointer",
                background: active ? R.navy : "transparent",
                color: active ? "#fdfbf7" : R.ink3,
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </Form>
  );
}

// ── decline-with-reason (WIRED: action.reject) ────────────────────────────────────
const DECLINE_REASONS: { value: string; label: string }[] = [
  { value: "too_aggressive", label: "Too aggressive" },
  { value: "wrong_products", label: "Wrong products" },
  { value: "bad_timing", label: "Bad timing" },
  { value: "already_handled", label: "Already handled it" },
  { value: "other", label: "Other" },
];

function DeclineForm({ actionRunId, onCancel }: { actionRunId: string; onCancel: () => void }) {
  const [reason, setReason] = useState(DECLINE_REASONS[0].value);
  return (
    <Form method="post" style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 8 }}>
      <input type="hidden" name="intent" value="action.reject" />
      <input type="hidden" name="actionRunId" value={actionRunId} />
      <input type="hidden" name="reason" value={reason} />
      <div style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.ink }}>Why decline? Jefe learns from this.</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {DECLINE_REASONS.map((rr) => {
          const active = rr.value === reason;
          return (
            <button
              key={rr.value}
              type="button"
              onClick={() => setReason(rr.value)}
              aria-pressed={active}
              style={{ fontFamily: R.sans, fontSize: 12, fontWeight: 600, padding: "5px 10px", borderRadius: RADIUS.button, cursor: "pointer", border: `1px solid ${active ? R.navy : R.controlBorder}`, background: active ? R.navy : "transparent", color: active ? "#fdfbf7" : R.ink3 }}
            >
              {rr.label}
            </button>
          );
        })}
      </div>
      <input
        name="reasonText"
        maxLength={140}
        placeholder="Anything to add? Optional — no customer details."
        style={{ fontFamily: R.sans, fontSize: 12.5, padding: "7px 10px", borderRadius: RADIUS.button, border: `1px solid ${R.controlBorder}`, background: R.surface, color: R.ink }}
      />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" style={{ fontFamily: R.sans, background: R.navy, color: "#fdfbf7", fontWeight: 600, fontSize: 12.5, padding: "8px 15px", borderRadius: RADIUS.button, border: "none", cursor: "pointer" }}>Send &amp; decline</button>
        <button type="button" onClick={onCancel} style={{ fontFamily: R.sans, background: "none", color: R.ink3, fontWeight: 600, fontSize: 12.5, padding: "8px 13px", borderRadius: RADIUS.button, border: `1px solid ${R.controlBorder}`, cursor: "pointer" }}>Cancel</button>
      </div>
    </Form>
  );
}

// ── edit the markdown (WIRED: action.edit → reviseAction) ─────────────────────────
function EditMarkdownForm({ actionRunId, currentPercent, onCancel }: { actionRunId: string; currentPercent: number; onCancel: () => void }) {
  const [percent, setPercent] = useState(String(currentPercent));
  return (
    <Form method="post" style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 8 }}>
      <input type="hidden" name="intent" value="action.edit" />
      <input type="hidden" name="actionRunId" value={actionRunId} />
      <div style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.ink }}>Adjust the markdown Jefe proposes</div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <input
          name="markdownPercent"
          type="number"
          min={1}
          max={95}
          step={1}
          value={percent}
          onChange={(e) => setPercent(e.target.value)}
          aria-label="Markdown percent"
          style={{ width: 72, fontFamily: R.sans, fontSize: 14, fontVariantNumeric: "tabular-nums", padding: "7px 10px", borderRadius: RADIUS.button, border: `1px solid ${R.controlBorder}`, background: R.surface, color: R.ink }}
        />
        <span style={{ fontFamily: R.sans, fontSize: 12.5, color: R.ink3 }}>% off — Jefe re-checks the floor, never below cost.</span>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" style={{ fontFamily: R.sans, background: R.navy, color: "#fdfbf7", fontWeight: 600, fontSize: 12.5, padding: "8px 15px", borderRadius: RADIUS.button, border: "none", cursor: "pointer" }}>Re-propose</button>
        <button type="button" onClick={onCancel} style={{ fontFamily: R.sans, background: "none", color: R.ink3, fontWeight: 600, fontSize: 12.5, padding: "8px 13px", borderRadius: RADIUS.button, border: `1px solid ${R.controlBorder}`, cursor: "pointer" }}>Cancel</button>
      </div>
    </Form>
  );
}

// A "Your call" row for the real, executable suggested action (clearance). Rendered in
// the 13a hairline idiom; the wired approve/decline/edit forms are unchanged.
function SuggestedActionRow({ action, last }: { action: SuggestedAction; last?: boolean }) {
  const canDecide = action.executable && Boolean(action.actionRunId);
  const [showDecline, setShowDecline] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  return (
    <Row last={last} align="flex-start">
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontFamily: R.sans, fontSize: 13.5, fontWeight: 600, color: R.ink }}>{action.headline}</div>
        {action.topItems?.length ? (
          <div style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3 }}>
            {action.topItems.slice(0, 3).map((it, i) => (
              <span key={i}>
                {i > 0 ? " · " : ""}
                <strong style={{ color: R.ink2, fontWeight: 600 }}>{it.title}</strong>
                {it.detail ? ` ${it.detail}` : ""}
              </span>
            ))}
          </div>
        ) : null}
        {action.actionType ? (
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 4, flexWrap: "wrap" }}>
            <span style={{ fontFamily: R.sans, fontSize: 12, color: R.label }}>How Jefe handles this</span>
            <ModePicker actionType={action.actionType} current={action.mode ?? "approve_execute"} compact />
          </div>
        ) : null}
        {canDecide ? (
          showDecline ? (
            <DeclineForm actionRunId={action.actionRunId ?? ""} onCancel={() => setShowDecline(false)} />
          ) : showEdit ? (
            <EditMarkdownForm actionRunId={action.actionRunId ?? ""} currentPercent={action.markdownPercent ?? 30} onCancel={() => setShowEdit(false)} />
          ) : (
            <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
              <Form method="post">
                <input type="hidden" name="intent" value="action.approve" />
                <input type="hidden" name="actionRunId" value={action.actionRunId} />
                <RustButton type="submit">Approve →</RustButton>
              </Form>
              <GhostButton onClick={() => setShowDecline(true)}>Decline</GhostButton>
              {typeof action.markdownPercent === "number" ? (
                <RustLink onClick={() => setShowEdit(true)} style={{ marginLeft: 2 }}>Adjust markdown · {action.markdownPercent}%</RustLink>
              ) : null}
            </div>
          )
        ) : (
          <div style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3, fontStyle: "italic", marginTop: 2 }}>
            {action.note ?? "Advisory for now — Jefe will action this for you once execution is switched on."}
          </div>
        )}
      </div>
      <Mono style={{ flex: "none", whiteSpace: "nowrap" }}>needs you</Mono>
    </Row>
  );
}

// ── BRIEF ────────────────────────────────────────────────────────────────────────
export function BriefSection({
  metrics,
  memory,
  recommendation,
  suggestedAction,
  executedActions,
  goals,
  findings,
  cur,
  headline,
}: {
  metrics: Metrics;
  memory: MemoryView;
  recommendation: Recommendation;
  suggestedAction: SuggestedAction | null;
  executedActions: ExecutedAction[];
  goals: Goal[];
  findings: Finding[];
  cur: string;
  headline: string;
}) {
  const groups = toMemoryGroups(memory);
  const beliefs = groups.flatMap((g) => g.entries).slice(0, 3);
  const counts = memoryCounts(groups);
  const waiting = (suggestedAction ? 1 : 0) + (recommendation ? 1 : 0) + findings.length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Mono>{eyebrowDate()}</Mono>
        <DisplayHeadline>{headline}</DisplayHeadline>
        <div style={{ display: "flex", gap: 26, flexWrap: "wrap", marginTop: 2 }}>
          <Metric label="Orders · 30d" value={metrics ? metrics.orders.toLocaleString("en-GB") : "—"} />
          <Metric label="Revenue · 30d" value={money(metrics?.monthlyRevenue, cur)} />
          <Metric label="Customers" value={metrics ? metrics.customers.toLocaleString("en-GB") : "—"} />
          <Metric label="Products" value={metrics ? metrics.products.toLocaleString("en-GB") : "—"} />
        </div>
      </div>

      {/* Your call */}
      <div>
        <SectionHeader title="Your call" meta={waiting > 0 ? `${waiting} waiting · A to approve` : undefined} />
        {waiting > 0 ? (
          <div>
            {findings.map((f, i) => (
              <FindingRow key={f.id} finding={f} last={i === findings.length - 1 && !suggestedAction && !recommendation} />
            ))}
            {suggestedAction ? <SuggestedActionRow action={suggestedAction} last={!recommendation} /> : null}
            {recommendation ? <RecommendationRow rec={recommendation} last /> : null}
          </div>
        ) : (
          <Row last>
            <span style={{ fontFamily: R.sans, fontSize: 13, color: R.ink3 }}>
              Nothing’s waiting on you right now. Jefe is reading the latest orders and will bring the next move when it’s worth ten minutes.
            </span>
          </Row>
        )}
      </div>

      {executedActions.length ? <ExecutedFeed actions={executedActions} /> : null}

      {/* What I’ve worked out so far */}
      <div>
        <SectionHeader title="What I’ve worked out so far" meta={counts.total > 0 ? `${counts.total} things` : undefined} />
        {beliefs.length ? (
          <div>
            {beliefs.map((e, i) => (
              <MemoryRow key={e.id} entry={e} last={i === beliefs.length - 1} />
            ))}
          </div>
        ) : (
          <Row last>
            <span style={{ fontFamily: R.sans, fontSize: 13, color: R.ink3 }}>Jefe is still reading your store — the first things he works out will show up here.</span>
          </Row>
        )}
      </div>

      {/* What we’re working on — goals, if any */}
      {goals && goals.length ? (
        <div>
          <SectionHeader title="What we’re working on" meta="Goals" />
          {goals.slice(0, 3).map((g, i) => (
            <Row key={g.id} last={i === Math.min(goals.length, 3) - 1} align="flex-start">
              <Mono style={{ flex: "none", width: 68, paddingTop: 1 }}>{horizonLabel(g.horizon)}</Mono>
              <span style={{ flex: 1, fontFamily: R.sans, fontSize: 13, color: R.ink2 }}>{g.title}</span>
            </Row>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// A finding — a real tidy-up/pattern surfaced from store data (gap #4). Never fabricated:
// findings are computed server-side; the section simply renders what it’s given.
export type Finding = {
  id: string;
  title: string;
  body: string;
  kind: string; // "tidy-up" | "pattern" | ...
  when?: string | null; // mono timestamp
  primary?: { label: string; href?: string } | null; // a real link, or omitted
  dismiss?: string | null; // secondary label, e.g. "I know about this"
};

function FindingRow({ finding, last }: { finding: Finding; last?: boolean }) {
  return (
    <Row last={last} align="flex-start">
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontFamily: R.sans, fontSize: 13.5, fontWeight: 600, color: R.ink }}>{finding.title}</div>
        <div style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3 }}>{finding.body}</div>
        {finding.primary || finding.dismiss ? (
          <div style={{ display: "flex", gap: 14, alignItems: "center", marginTop: 4 }}>
            {finding.primary ? (
              finding.primary.href ? (
                <a href={finding.primary.href} style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust, textDecoration: "none" }}>{finding.primary.label}</a>
              ) : (
                <span style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust }}>{finding.primary.label}</span>
              )
            ) : null}
            {finding.dismiss ? <span style={{ fontFamily: R.sans, fontSize: 12.5, color: R.ink4 }}>{finding.dismiss}</span> : null}
          </div>
        ) : null}
      </div>
      {finding.when ? <Mono style={{ flex: "none", whiteSpace: "nowrap" }}>{finding.kind} · {finding.when}</Mono> : <Mono style={{ flex: "none" }}>{finding.kind}</Mono>}
    </Row>
  );
}

// The Plan recommendation as a "Your call" row. Plan-rec EXECUTION isn’t wired (only
// clearance is), so this is honest: reasoning is a real expander, no fake Approve.
function RecommendationRow({ rec, last }: { rec: NonNullable<Recommendation>; last?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Row last={last} align="flex-start">
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ fontFamily: R.sans, fontSize: 13.5, fontWeight: 600, color: R.ink }}>{rec.title}</div>
        <div style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3 }}>{rec.whyThisAction || rec.summary}</div>
        <div style={{ marginTop: 4 }}>
          <RustLink onClick={() => setOpen((v) => !v)}>{open ? "Hide the reasoning" : "How I got this ›"}</RustLink>
        </div>
        {open ? (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 7 }}>
            {rec.whyNow ? <div style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink2 }}><strong style={{ fontWeight: 600 }}>Why now:</strong> {rec.whyNow}</div> : null}
            {rec.executionSteps?.length ? (
              <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 3 }}>
                {rec.executionSteps.map((s, i) => (
                  <li key={i} style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink2 }}><strong style={{ fontWeight: 600 }}>{s.title}</strong>{s.description ? ` — ${s.description}` : ""}</li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
      <Mono style={{ flex: "none", whiteSpace: "nowrap" }}>plan · {rec.confidence}</Mono>
    </Row>
  );
}

function ExecutedFeed({ actions }: { actions: ExecutedAction[] }) {
  if (!actions.length) return null;
  return (
    <div>
      <SectionHeader title="What Jefe did" />
      {actions.map((a, i) => {
        const reverted = a.status === "reverted";
        const when = reverted ? a.revertedAt : a.appliedAt;
        return (
          <Row key={a.actionRunId} last={i === actions.length - 1} align="flex-start">
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontFamily: R.sans, fontSize: 13, fontWeight: 600, color: reverted ? R.ink4 : R.ink }}>{a.headline}</span>
              <span style={{ fontFamily: R.sans, fontSize: 12, lineHeight: 1.45, color: R.ink3 }}>
                {reverted ? "Attempted, then rolled back automatically — nothing was left changed." : a.outcome.measured ? a.outcome.summary ?? "Done." : "Jefe’s tracking the results."}
              </span>
            </div>
            {when ? <Mono style={{ flex: "none" }}>{formatFeedDate(when)}</Mono> : null}
          </Row>
        );
      })}
    </div>
  );
}

// ── MEMORY (gaps #1 + #2) ─────────────────────────────────────────────────────────
// NOTE: confirm/correct/edit/forget actions below need memory.* intents wired (chat 9)
// before this goes live. Statements + provenance + authorship are real improvements now.
function MemoryRow({ entry, last }: { entry: MemoryEntry; last?: boolean }) {
  const body = (
    <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
      <span style={{ fontFamily: R.sans, fontSize: 13.5, lineHeight: 1.4, color: R.ink }}>{entry.statement}</span>
      {entry.sourceLine ? <SourceLine>{entry.sourceLine}{entry.confirmState === "unsure" ? " · confirm?" : ""}</SourceLine> : null}
    </div>
  );
  const actions =
    entry.confirmState === "unsure" ? (
      <div style={{ flex: "none", display: "flex", gap: 12, alignItems: "center" }}>
        <span style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust }}>That’s right</span>
        <span style={{ fontFamily: R.sans, fontSize: 12.5, color: R.ink4 }}>Not quite</span>
      </div>
    ) : entry.confirmState === "blocked" ? (
      <span style={{ flex: "none", fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust }}>Tell me</span>
    ) : (
      <div style={{ flex: "none", display: "flex", gap: 12, alignItems: "center" }}>
        <span style={{ fontFamily: R.sans, fontSize: 12.5, color: R.ink4 }}>Edit</span>
        <span style={{ fontFamily: R.sans, fontSize: 12.5, color: R.ink4 }}>Forget</span>
      </div>
    );

  const inner = (
    <Row last={last} align="flex-start" style={entry.authored ? { paddingLeft: 0 } : undefined}>
      {body}
      {actions}
    </Row>
  );
  // The 3px navy rule marks merchant-authored / confirm-pending entries (rule 2).
  return entry.authored ? <AuthorshipRule style={{ borderBottom: last ? "none" : `1px solid ${R.hairline}` }}><Row last align="flex-start" style={{ borderBottom: "none" }}>{body}{actions}</Row></AuthorshipRule> : inner;
}

export function MemorySection({ storeName, memory }: { storeName: string; memory: MemoryView }) {
  const groups = toMemoryGroups(memory).filter((g) => g.entries.length > 0);
  const counts = memoryCounts(groups);
  const metaParts = [
    `${counts.total} ${counts.total === 1 ? "thing" : "things"}`,
    counts.told > 0 ? `${counts.told} you taught me` : null,
    counts.unsure > 0 ? `${counts.unsure} waiting on you` : null,
  ].filter(Boolean);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
          <DisplayHeadline>Memory</DisplayHeadline>
          <Mono style={{ fontSize: 11 }}>{metaParts.join(" · ")}</Mono>
        </div>
      </div>

      {groups.length === 0 ? (
        <Row last>
          <span style={{ fontFamily: R.sans, fontSize: 13, lineHeight: 1.5, color: R.ink3 }}>
            This is a file, not a feed — everything Jefe works out about {storeName || "your store"}, where it came from, and whether you’ve confirmed it. It fills up as he reads your store and as you talk to him.
          </span>
        </Row>
      ) : (
        groups.map((g) => (
          <div key={g.key}>
            <SectionHeader title={g.label} meta={String(g.entries.length)} />
            {g.entries.map((e, i) => (
              <MemoryRow key={e.id} entry={e} last={i === g.entries.length - 1} />
            ))}
          </div>
        ))
      )}
    </div>
  );
}

// ── HORIZON ────────────────────────────────────────────────────────────────────
// Honest limits (gap: "what I can’t see yet"). Near-term items + a "watching, not acting"
// block with explicit revisit dates. Content is passed in (computed server-side); the
// section never invents a stockout or a refund projection.
export type HorizonItem = { id: string; date: string; title: string; body: string; action?: { label: string; href?: string } | null };
export type HorizonWatch = { id: string; title: string; reason: string };

export function HorizonSection({ near, watching }: { near: HorizonItem[]; watching: HorizonWatch[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <DisplayHeadline>Horizon</DisplayHeadline>
        <div style={{ fontFamily: R.sans, fontSize: 13, lineHeight: 1.55, color: R.ink3, maxWidth: 620 }}>
          What’s coming that you can still do something about. Jefe is cautious here — with a short history he can see runway, not seasons.
        </div>
      </div>

      {near.length ? (
        <div>
          <SectionHeader title="Next two weeks" />
          {near.map((it, i) => (
            <Row key={it.id} last={i === near.length - 1} align="flex-start">
              <Mono style={{ flex: "none", width: 60, paddingTop: 2 }}>{it.date}</Mono>
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: R.sans, fontSize: 13.5, fontWeight: 600, color: R.ink }}>{it.title}</span>
                <span style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3 }}>{it.body}</span>
              </div>
              {it.action ? (
                it.action.href ? (
                  <a href={it.action.href} style={{ flex: "none", fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust, textDecoration: "none" }}>{it.action.label}</a>
                ) : (
                  <span style={{ flex: "none", fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust }}>{it.action.label}</span>
                )
              ) : null}
            </Row>
          ))}
        </div>
      ) : null}

      {watching.length ? (
        <div>
          <SectionHeader title="Watching, not acting" />
          {watching.map((w, i) => (
            <Row key={w.id} last={i === watching.length - 1} align="flex-start">
              <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: R.sans, fontSize: 13.5, color: R.ink2 }}>{w.title}</span>
                <SourceLine>{w.reason}</SourceLine>
              </div>
            </Row>
          ))}
        </div>
      ) : null}

      <AuthorshipRule>
        <span style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.55, color: R.ink3 }}>
          Jefe would rather tell you what he can’t see yet than guess. Everything above is dated, so you can hold him to it.
        </span>
      </AuthorshipRule>
    </div>
  );
}

// ── GOALS ──────────────────────────────────────────────────────────────────────
export function GoalsSection({ goals, changes }: { goals: Goal[]; changes: GoalChange[] }) {
  if (!goals || goals.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <DisplayHeadline>Goals</DisplayHeadline>
        <Row last>
          <span style={{ fontFamily: R.sans, fontSize: 13, lineHeight: 1.5, color: R.ink3 }}>
            No direction set yet. Goals are where you tell Jefe what winning looks like at 3, 6 and 12 months — set them in onboarding, or just tell Jefe and he’ll draft them with you.
          </span>
        </Row>
      </div>
    );
  }
  const ordered = [...goals].sort((a, b) => horizonRank(a.horizon) - horizonRank(b.horizon));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <DisplayHeadline>Goals</DisplayHeadline>
        <div style={{ fontFamily: R.sans, fontSize: 13, lineHeight: 1.55, color: R.ink3, maxWidth: 620 }}>
          You set these during onboarding. They change what Jefe brings you first.
        </div>
      </div>

      <div>
        {ordered.map((g, i) => (
          <AuthorshipRule key={g.id} style={{ borderBottom: i === ordered.length - 1 ? "none" : `1px solid ${R.hairline}`, paddingTop: i === 0 ? 0 : 12, paddingBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
              <Mono style={{ flex: "none", width: 64 }}>{horizonLabel(g.horizon)}</Mono>
              <span style={{ flex: 1, fontFamily: R.sans, fontSize: 14, fontWeight: 600, color: R.ink }}>{g.title}</span>
            </div>
            {g.description ? <div style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3, marginTop: 4, paddingLeft: 74 }}>{g.description}</div> : null}
          </AuthorshipRule>
        ))}
      </div>

      {changes.length ? (
        <div>
          <SectionHeader title="What these changed" />
          {changes.map((c, i) => (
            <Row key={c.id} last={i === changes.length - 1}>
              <span style={{ flex: 1, fontFamily: R.sans, fontSize: 13, color: R.ink2 }}>{c.text}</span>
              {c.since ? <Mono style={{ flex: "none" }}>since {c.since}</Mono> : null}
            </Row>
          ))}
        </div>
      ) : (
        <div style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3 }}>
          As Jefe works moves against each goal, you’ll see here what each one changed about what he does.
        </div>
      )}
    </div>
  );
}
export type GoalChange = { id: string; text: string; since?: string | null };

// ── QUEUE ──────────────────────────────────────────────────────────────────────
export type QueueItem = {
  id: string;
  title: string;
  when: string; // mono
  kind: string;
  state: "needs_you" | "did_it" | "declined";
  group?: string | null; // day/section grouping label
  note?: string | null; // e.g. a decline reason
};

export function QueueSection({ items }: { items: QueueItem[] }) {
  const waiting = items.filter((i) => i.state === "needs_you");
  const done = items.filter((i) => i.state === "did_it");
  const declined = items.filter((i) => i.state === "declined");

  if (items.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <DisplayHeadline>Queue</DisplayHeadline>
        <Row last>
          <span style={{ fontFamily: R.sans, fontSize: 13, lineHeight: 1.5, color: R.ink3 }}>
            Nothing in the queue right now. Jefe keeps working in the background and brings the next move here when it’s worth your time — every decline carries a reason, and that’s how he learns.
          </span>
        </Row>
      </div>
    );
  }

  const stateLabel = (s: QueueItem["state"]) =>
    s === "needs_you" ? <span style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust }}>Needs you</span> : s === "declined" ? <Mono>you declined</Mono> : <Mono>Jefe did it</Mono>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 12 }}>
        <DisplayHeadline>Queue</DisplayHeadline>
        <div style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "baseline" }}>
          <Mono>Waiting {waiting.length}</Mono>
          <Mono>Handled {done.length}</Mono>
          <Mono>Declined {declined.length}</Mono>
        </div>
      </div>

      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, paddingBottom: 7, borderBottom: `1px solid ${R.frame}` }}>
          <span style={{ flex: 1, fontFamily: R.sans, fontSize: 12, fontWeight: 700, color: R.label }}>Move</span>
          <span style={{ flex: "none", width: 70, fontFamily: R.sans, fontSize: 12, fontWeight: 700, color: R.label }}>When</span>
          <span style={{ flex: "none", width: 90, fontFamily: R.sans, fontSize: 12, fontWeight: 700, color: R.label }}>Kind</span>
          <span style={{ flex: "none", width: 92, textAlign: "right", fontFamily: R.sans, fontSize: 12, fontWeight: 700, color: R.label }}>State</span>
          <KeyHint>J / K to move · A to approve</KeyHint>
        </div>
        {items.map((it) => (
          <div key={it.id}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: `1px solid ${R.hairline}` }}>
              <span style={{ flex: 1, minWidth: 0, fontFamily: R.sans, fontSize: 13, fontWeight: it.state === "needs_you" ? 600 : 400, color: it.state === "did_it" ? R.ink3 : R.ink }}>{it.title}</span>
              <Mono style={{ flex: "none", width: 70 }}>{it.when}</Mono>
              <span style={{ flex: "none", width: 90, fontFamily: R.sans, fontSize: 12.5, color: R.ink3 }}>{it.kind}</span>
              <span style={{ flex: "none", width: 92, textAlign: "right" }}>{stateLabel(it.state)}</span>
            </div>
            {it.note ? (
              <AuthorshipRule style={{ margin: "4px 0 10px" }}>
                <span style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.5, color: R.ink3 }}>{it.note}</span>
              </AuthorshipRule>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SETTINGS ───────────────────────────────────────────────────────────────────
export type ActionPolicy = { actionType: string; label: string; detail: string; mode: ActionMode | null; blockedReason?: string | null };
export type ChannelRow = { id: string; label: string; value: string; connected: boolean };

export function SettingsSection({ policies, channels }: { policies: ActionPolicy[]; channels: ChannelRow[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 26 }}>
      <DisplayHeadline>Settings</DisplayHeadline>

      <div>
        <SectionHeader title="How much rope Jefe gets" meta="Per kind of action. Change it whenever." />
        {policies.map((p, i) => (
          <Row key={p.actionType} last={i === policies.length - 1}>
            <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontFamily: R.sans, fontSize: 13, fontWeight: 600, color: R.ink }}>{p.label}</span>
              <span style={{ fontFamily: R.sans, fontSize: 12, color: R.ink3 }}>{p.detail}</span>
            </div>
            {p.mode ? (
              <ModePicker actionType={p.actionType} current={p.mode} compact />
            ) : (
              <span style={{ flex: "none", fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust }}>{p.blockedReason || "Set up"}</span>
            )}
          </Row>
        ))}
        <AuthorshipRule style={{ marginTop: 12 }}>
          <span style={{ fontFamily: R.sans, fontSize: 12.5, lineHeight: 1.55, color: R.ink3 }}>
            Autonomous still has limits: nothing below your margin floor, and every action is reversible from the queue.
          </span>
        </AuthorshipRule>
      </div>

      <div>
        <SectionHeader title="Where Jefe reaches you" />
        {channels.map((c, i) => (
          <Row key={c.id} last={i === channels.length - 1}>
            <span style={{ flex: 1, fontFamily: R.sans, fontSize: 13, fontWeight: 600, color: R.ink }}>{c.label}</span>
            <span style={{ fontFamily: R.sans, fontSize: 12.5, color: R.ink3 }}>{c.value}</span>
            {!c.connected ? <span style={{ fontFamily: R.sans, fontSize: 12.5, fontWeight: 600, color: R.rust }}>Connect</span> : null}
          </Row>
        ))}
      </div>
    </div>
  );
}

// ── local helpers (kept in-module so the section file is self-contained) ──────────
function eyebrowDate(): string {
  return new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}
function formatFeedDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
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
