import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "react-router";

// The reachable Merchant Memory surface (?view=memory) is the merchant's window into what
// Jefe believes about their business. It deliberately mirrors /app/settings sizing and
// navigation because Settings is the way into this screen, while keeping ?view=memory as
// the stable route.

type MemoryBelief = {
  id: string;
  key: string;
  title: string;
  value: string;
  status: string;
  correctable: boolean;
  evidenceSummary: string | null;
  statusLabel: string;
  statusTone: "success" | "attention" | "info";
  statement?: string | null;
  sourceLine?: string | null;
  authorship?: "merchant" | "jefe" | null;
  confirmState?: "settled" | "unsure" | null;
  confirmPriority?: number;
};

type MemoryGroup = {
  category: string;
  label: string;
  beliefs: MemoryBelief[];
};

type MemoryData = {
  groups: MemoryGroup[];
};

type MemoryConversation = {
  messages: Array<{ id: string; role: string; content: string }>;
  summary?: { openQuestions?: Array<{ id: string; question: string; reason: string | null }> | null } | null;
};

type VisibleBelief = MemoryBelief & {
  displayName: string;
  displayValue: string;
  searchableText: string;
};

type VisibleGroup = {
  category: string;
  label: string;
  beliefs: VisibleBelief[];
};

function settingsHref(search: string, panel: string) {
  const params = new URLSearchParams(search);
  params.delete("view");
  params.set("panel", panel);
  return `/app/settings?${params.toString()}`;
}

function homeHref(search: string) {
  const params = new URLSearchParams(search);
  params.delete("view");
  params.delete("panel");
  const qs = params.toString();
  return `/app${qs ? `?${qs}` : ""}`;
}

function displayNameFor(belief: MemoryBelief) {
  return (belief.statement || belief.title || belief.key).trim();
}

function displayValueFor(belief: MemoryBelief) {
  const value = (belief.value || "").trim();
  if (value && value !== displayNameFor(belief)) return value;
  if (belief.authorship === "merchant") return "Told";
  if (belief.confirmState === "unsure") return "Inferred";
  return belief.statusLabel || "";
}

function sourceFor(belief: MemoryBelief) {
  if (belief.sourceLine) return belief.sourceLine;
  if (belief.evidenceSummary) return belief.evidenceSummary;
  if (belief.authorship === "merchant") return "you told Jefe";
  return "from your store data";
}

function searchText(group: MemoryGroup, belief: MemoryBelief) {
  return [
    group.label,
    group.category,
    belief.key,
    belief.title,
    belief.statement,
    belief.value,
    belief.sourceLine,
    belief.evidenceSummary,
    belief.statusLabel,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function countBeliefs(groups: Array<{ beliefs: unknown[] }>) {
  return groups.reduce((count, group) => count + group.beliefs.length, 0);
}

function latestRecheckLabel(groups: MemoryGroup[]) {
  const lines = groups.flatMap((group) =>
    group.beliefs
      .map((belief) => belief.sourceLine)
      .filter((line): line is string => Boolean(line)),
  );
  const lineWithRecheck = lines.find((line) => line.includes("rechecked "));
  if (!lineWithRecheck) return null;
  const match = lineWithRecheck.match(/rechecked\s+(.+)$/);
  return match?.[1] ?? null;
}

function isLongDisplayValue(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 24 || (trimmed.length > 18 && /[./_-]/.test(trimmed));
}

function BeliefRow({
  belief,
  expanded,
  onToggle,
}: {
  belief: VisibleBelief;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasLongValue = isLongDisplayValue(belief.displayValue);
  return (
    <div style={beliefShellStyle}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={hasLongValue ? beliefButtonLongValueStyle : beliefButtonStyle}
      >
        <span style={beliefTextStyle}>
          <span style={beliefNameStyle}>{belief.displayName}</span>
          <span style={beliefMetaStyle}>{sourceFor(belief)}</span>
          {hasLongValue ? (
            <span style={beliefLongValueStyle}>{belief.displayValue}</span>
          ) : null}
        </span>
        {hasLongValue ? null : <span style={beliefValueStyle}>{belief.displayValue}</span>}
        <span aria-hidden="true" style={caretStyle}>
          {expanded ? "▲" : "▼"}
        </span>
      </button>
      {expanded ? (
        <div style={beliefDetailStyle}>
          {belief.evidenceSummary || belief.sourceLine || sourceFor(belief)}
        </div>
      ) : null}
    </div>
  );
}

export function MerchantMemoryView({
  storeName,
  memory,
}: {
  storeName: string;
  merchantName: string;
  memory: MemoryData;
  conversation: MemoryConversation | null;
}) {
  const location = useLocation();
  const [query, setQuery] = useState("");
  const [expandedBeliefId, setExpandedBeliefId] = useState<string | null>(null);

  const totalCount = countBeliefs(memory.groups);
  const q = query.trim().toLowerCase();
  const visibleGroups = useMemo<VisibleGroup[]>(() => {
    return memory.groups
      .map((group) => {
        const beliefs = group.beliefs
          .map((belief) => ({
            ...belief,
            displayName: displayNameFor(belief),
            displayValue: displayValueFor(belief),
            searchableText: searchText(group, belief),
          }))
          .filter((belief) => !q || belief.searchableText.includes(q));
        return { category: group.category, label: group.label, beliefs };
      })
      .filter((group) => group.beliefs.length > 0);
  }, [memory.groups, q]);
  const shownCount = countBeliefs(visibleGroups);
  const rechecked = latestRecheckLabel(memory.groups);
  const shownLabel = q ? `${shownCount} of ${totalCount} shown` : `${totalCount} things`;

  return (
    <main style={pageStyle} className="JefeMemoryView">
      <div style={shellStyle}>
        <Link to={homeHref(location.search)} style={backLinkStyle}>
          ← Home
        </Link>
        <h1 style={titleStyle}>Settings</h1>

        <div style={rowStyle}>
          <nav style={navStyle} aria-label="Settings sections">
            <Link to={settingsHref(location.search, "autonomy")} style={navItemStyle}>
              Autonomy
            </Link>
            <Link to={settingsHref(location.search, "integrations")} style={navItemStyle}>
              Integrations
            </Link>
            <Link to={settingsHref(location.search, "channels")} style={navItemStyle}>
              Channels
            </Link>
            <Link to={settingsHref(location.search, "settings")} style={navItemStyle}>
              Notifications
            </Link>
            <Link
              to={`${location.pathname}${location.search}`}
              aria-current="page"
              style={{ ...navItemStyle, ...navItemActiveStyle }}
            >
              What Jefe knows
            </Link>
          </nav>

          <section style={panelStyle} aria-live="polite">
            <div style={panelHeaderStyle}>
              <h2 style={panelTitleStyle}>What Jefe knows</h2>
              <p style={panelBlurbStyle}>
                Everything Jefe has worked out about {storeName}, plus what you&apos;ve told him.
              </p>
            </div>

            <div style={toolbarStyle}>
              <input
                aria-label="Search what Jefe knows"
                placeholder="Search what Jefe knows"
                value={query}
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setExpandedBeliefId(null);
                }}
                style={searchStyle}
              />
              <span style={countStyle}>
                {shownLabel}
                {rechecked ? ` · rechecked ${rechecked}` : ""}
              </span>
            </div>

            {totalCount === 0 ? (
              <div style={emptyStyle}>
                Jefe is still reading your store. What he works out shows up here.
              </div>
            ) : visibleGroups.length === 0 ? (
              <div style={emptyStyle}>Nothing matches that. Try a different word.</div>
            ) : (
              <div style={groupsStyle}>
                {visibleGroups.map((group) => (
                  <div key={group.category} style={groupStyle}>
                    <div style={groupHeaderStyle}>
                      <span style={groupNameStyle}>{group.label}</span>
                      <span style={groupCountStyle}>{group.beliefs.length}</span>
                    </div>
                    {group.beliefs.map((belief) => (
                      <BeliefRow
                        key={belief.id}
                        belief={belief}
                        expanded={expandedBeliefId === belief.id}
                        onToggle={() =>
                          setExpandedBeliefId((current) =>
                            current === belief.id ? null : belief.id,
                          )
                        }
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}

            <div style={footerStyle}>Jefe rechecks these against your store data every day.</div>
          </section>
        </div>
      </div>
    </main>
  );
}

const COLORS = {
  page: "#fbfaf7",
  card: "#fffdfa",
  border: "#d8d0c8",
  hairline: "#ede7de",
  ink: "#1f2933",
  body: "#4d463f",
  muted: "#6d7175",
  faint: "#8a8177",
  navy: "#1f3a63",
  soft: "#fbfaf7",
};

const SANS = "'Schibsted Grotesk', system-ui, -apple-system, sans-serif";

const pageStyle: CSSProperties = {
  minHeight: "100vh",
  background: COLORS.page,
  color: COLORS.ink,
  fontFamily: SANS,
  padding: "48px 24px 96px",
};
const shellStyle: CSSProperties = {
  maxWidth: 1180,
  margin: "0 auto",
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 28,
};
const backLinkStyle: CSSProperties = {
  alignSelf: "flex-start",
  color: COLORS.muted,
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
};
const titleStyle: CSSProperties = {
  margin: 0,
  color: COLORS.ink,
  fontSize: 26,
  fontWeight: 700,
};
const rowStyle: CSSProperties = {
  display: "flex",
  gap: 24,
  alignItems: "flex-start",
  flexWrap: "wrap",
};
const navStyle: CSSProperties = {
  flex: "0 0 232px",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};
const navItemStyle: CSSProperties = {
  display: "block",
  padding: "9px 12px",
  borderRadius: 8,
  color: COLORS.body,
  fontSize: 14,
  fontWeight: 500,
  textDecoration: "none",
  borderLeft: "2px solid transparent",
};
const navItemActiveStyle: CSSProperties = {
  background: COLORS.card,
  borderLeft: `2px solid ${COLORS.navy}`,
  color: COLORS.ink,
  fontWeight: 600,
};
const panelStyle: CSSProperties = {
  flex: "1 1 420px",
  minWidth: 0,
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 14,
  padding: "22px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const panelHeaderStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const panelTitleStyle: CSSProperties = {
  margin: 0,
  color: COLORS.ink,
  fontSize: 17,
  fontWeight: 700,
  letterSpacing: 0,
};
const panelBlurbStyle: CSSProperties = {
  margin: 0,
  maxWidth: "64ch",
  color: COLORS.muted,
  fontSize: 13.5,
  lineHeight: 1.5,
};
const toolbarStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};
const searchStyle: CSSProperties = {
  flex: "1 1 220px",
  maxWidth: 300,
  height: 34,
  boxSizing: "border-box",
  padding: "0 12px",
  border: `1px solid ${COLORS.border}`,
  borderRadius: 9,
  background: "#ffffff",
  color: COLORS.ink,
  fontFamily: SANS,
  fontSize: 13,
};
const countStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 13,
  fontVariantNumeric: "tabular-nums",
};
const groupsStyle: CSSProperties = { display: "flex", flexDirection: "column", gap: 22 };
const groupStyle: CSSProperties = { display: "flex", flexDirection: "column" };
const groupHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  paddingBottom: 8,
};
const groupNameStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};
const groupCountStyle: CSSProperties = {
  color: COLORS.faint,
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
};
const beliefShellStyle: CSSProperties = { borderTop: `1px solid ${COLORS.hairline}` };
const beliefButtonStyle: CSSProperties = {
  width: "100%",
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) minmax(72px, 116px) 18px",
  alignItems: "center",
  gap: 12,
  padding: "13px 6px 13px 0",
  border: 0,
  borderRadius: 8,
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
  fontFamily: SANS,
};
const beliefButtonLongValueStyle: CSSProperties = {
  ...beliefButtonStyle,
  gridTemplateColumns: "minmax(0, 1fr) 18px",
  alignItems: "start",
  padding: "13px 8px 15px 0",
};
const beliefTextStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  minWidth: 0,
};
const beliefNameStyle: CSSProperties = {
  minWidth: 0,
  color: COLORS.ink,
  fontSize: 14,
  fontWeight: 700,
  overflowWrap: "anywhere",
};
const beliefMetaStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 12.5,
  overflowWrap: "anywhere",
};
const beliefValueStyle: CSSProperties = {
  color: COLORS.ink,
  fontSize: 14,
  fontWeight: 700,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};
const beliefLongValueStyle: CSSProperties = {
  marginTop: 8,
  maxWidth: "76ch",
  color: COLORS.body,
  fontSize: 14,
  fontWeight: 500,
  lineHeight: 1.5,
  overflowWrap: "break-word",
};
const caretStyle: CSSProperties = {
  color: COLORS.faint,
  fontSize: 10,
  textAlign: "center",
};
const beliefDetailStyle: CSSProperties = {
  margin: "0 0 14px",
  padding: "12px 14px",
  borderRadius: 10,
  background: COLORS.soft,
  color: COLORS.body,
  fontSize: 13,
  lineHeight: 1.55,
};
const emptyStyle: CSSProperties = {
  padding: "28px 0 32px",
  color: COLORS.muted,
  fontSize: 14,
  textAlign: "center",
};
const footerStyle: CSSProperties = {
  padding: "14px 0 16px",
  borderTop: `1px solid ${COLORS.hairline}`,
  color: COLORS.muted,
  fontSize: 13,
};
