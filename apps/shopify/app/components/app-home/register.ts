// The "13a" visual register — the styling contract for the redesigned app home.
// Source of truth: design_handoff_jefe_app/VISUAL_REGISTER.md (turn 13a). This is a
// deliberate departure from the older "5a" oklch token object `T` in daily-home.tsx:
// flat surface, hairlines not cards, radius 4, figures in the text face (not mono),
// one functional accent. Every value here is flat hex and every text colour clears
// WCAG AA (4.5:1) at the size it is used — see the notes in VISUAL_REGISTER.md §"Colours".
//
// Pairing rule to preserve when extending this: control borders and readable text are
// SEPARATE scales. `controlBorder` (#877e6c, 3.88:1) is for checkbox/segmented/input
// outlines only; anything a person READS needs `label` (#6e6757) or darker.

export const R = {
  // Surfaces
  surface: "#fdfbf7", // the single page surface — one flat plane, no gradient
  activeNav: "#f6f1e8", // active nav row background (with the rust left-rule)
  wash: "#f7f2ea", // faint grouped-header / day-divider wash

  // Lines (rule 2: group with hairlines + space, never cards)
  frame: "#d9d2c6", // outer frame border + the rule under a section header
  divider: "#e3ddd2", // column dividers
  hairline: "#ece7dc", // row hairlines

  // Ink + text scale (rule: smaller type → darker grey)
  ink: "#2b2b2e", // body and ALL figures (money, counts, %)
  ink2: "#3a3833", // secondary
  ink3: "#4c4a45", // tertiary
  ink4: "#55524b", // quaternary
  label: "#6e6757", // labels, 12px, 4.8:1
  metaMono: "#5f5949", // mono metadata, 10–10.5px (the smallest type → darker grey)

  // Controls
  controlBorder: "#877e6c", // UNSELECTED control outlines only (3.88:1) — never on text

  // The one accent + the two special-purpose colours
  rust: "#8c4030", // needs-you actions, links, unresolved counts
  rustHover: "#6f3024",
  navy: "#33456b", // the 3px authorship/correction left-rule and its button
  navyHover: "#293656",
  positive: "#2f6b45", // positive delta only

  // Type roles (loaded globally in root.tsx)
  sans: "'Schibsted Grotesk', system-ui, -apple-system, sans-serif",
  serif: "'Instrument Serif', Georgia, 'Times New Roman', serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
} as const;

// Radii (rule 3): the surface is flat. Panels radius 4, buttons radius 5. No 18px pills.
export const RADIUS = { panel: 4, button: 5, chip: 4 } as const;

// en-GB number formatting — money is ink, never rust (rule 6).
export function enGB(n: number): string {
  return n.toLocaleString("en-GB");
}
export function currencySymbol(code: string | null | undefined): string {
  const c = (code || "GBP").toUpperCase();
  if (c === "GBP") return "£";
  if (c === "USD" || c === "CAD" || c === "AUD" || c === "NZD") return "$";
  if (c === "EUR") return "€";
  if (c === "JPY") return "¥";
  return c + " ";
}
export function money(n: number | null | undefined, code: string): string {
  if (n == null) return "—";
  return currencySymbol(code) + enGB(Math.round(n));
}

// Figure styles (rule 1). Two variants, deliberately:
//  - column: tabular-nums so stacked figures align in a column.
//  - display: proportional nums — at 26px+, tabular-nums pads a comma to a full digit
//    slot and renders "£1 , 104" (VISUAL_REGISTER "Notes for implementation").
export const figureColumn: React.CSSProperties = {
  fontFamily: R.sans,
  fontWeight: 600,
  fontVariantNumeric: "tabular-nums",
  color: R.ink,
};
export const figureDisplay: React.CSSProperties = {
  fontFamily: R.sans,
  fontWeight: 600,
  color: R.ink,
};

// Mono earns its place ONLY on: timestamps, sync/system state, keyboard hints, IDs/SKUs.
export const monoMeta: React.CSSProperties = {
  fontFamily: R.mono,
  fontSize: 10.5,
  color: R.metaMono,
  letterSpacing: "0.2px",
};

// A readable 12px label (NOT the control-border grey).
export const labelText: React.CSSProperties = {
  fontFamily: R.sans,
  fontSize: 12,
  color: R.label,
};
