import { R, RADIUS, monoMeta } from "./register";

// Reusable primitives for the 13a app home. These encode the register so a screen
// can't drift from it: hairline grouping (never cards), plain-bold section headers,
// figures in the text face, the 3px navy authorship rule, mono reserved for metadata.
// All presentational — anything that POSTs (mode picker, approve/decline) stays in the
// section files where it can own the wired <Form>.

// ── Section header (rule 5): plain bold 13px over a hairline. Optional right-side meta
//    (a count, a filter, "all of it"). NOT an uppercase mono eyebrow.
export function SectionHeader({
  title,
  meta,
  id,
}: {
  title: string;
  meta?: React.ReactNode;
  id?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        gap: 12,
        paddingBottom: 7,
        marginBottom: 2,
        borderBottom: `1px solid ${R.frame}`,
      }}
    >
      <h2
        id={id}
        style={{ margin: 0, fontFamily: R.sans, fontWeight: 700, fontSize: 13, color: R.ink, letterSpacing: 0 }}
      >
        {title}
      </h2>
      {meta != null ? <div style={{ marginLeft: "auto", ...monoMeta, fontSize: 11.5 }}>{meta}</div> : null}
    </div>
  );
}

// ── A hairline-grouped row (rule 2 + 4): 1px #ece7dc between rows, dense padding.
export function Row({
  children,
  last = false,
  align = "center",
  style,
}: {
  children: React.ReactNode;
  last?: boolean;
  align?: React.CSSProperties["alignItems"];
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: align,
        gap: 12,
        padding: "11px 0",
        borderBottom: last ? "none" : `1px solid ${R.hairline}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── The one exception to "no fills": a 3px navy left-rule (rule 2). Marks something
//    genuinely different in kind — a merchant-authored fact or a correction Jefe is
//    asking you to confirm. Flush left, no fill, no radius.
export function AuthorshipRule({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ borderLeft: `3px solid ${R.navy}`, paddingLeft: 14, ...style }}>{children}</div>
  );
}

// ── Provenance line under a statement: where it came from + who said it (mono metadata).
export function SourceLine({ children }: { children: React.ReactNode }) {
  return <div style={{ ...monoMeta, marginTop: 3 }}>{children}</div>;
}

// ── Mono metadata span — timestamps, sync state, keyboard hints, IDs/SKUs ONLY.
export function Mono({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <span style={{ ...monoMeta, ...style }}>{children}</span>;
}

// ── A keyboard hint on a list header (rule 8: small evidence of daily use).
export function KeyHint({ children }: { children: React.ReactNode }) {
  return <span style={{ ...monoMeta, fontSize: 10, color: R.metaMono }}>{children}</span>;
}

// ── Positive delta — the one other colour (rule 6).
export function PositiveDelta({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: R.sans, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: R.positive }}>{children}</span>;
}

// ── The accent action (rule 6): rust, only for things that need the user. Solid = primary.
export function RustButton({
  children,
  type = "button",
  onClick,
  title,
  style,
}: {
  children: React.ReactNode;
  type?: "button" | "submit";
  onClick?: () => void;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      style={{
        fontFamily: R.sans,
        fontWeight: 600,
        fontSize: 13,
        color: "#fdfbf7",
        background: R.rust,
        border: "none",
        borderRadius: RADIUS.button,
        padding: "8px 14px",
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ── A quiet secondary action: text in ink with a control-border outline.
export function GhostButton({
  children,
  type = "button",
  onClick,
  title,
  style,
}: {
  children: React.ReactNode;
  type?: "button" | "submit";
  onClick?: () => void;
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      style={{
        fontFamily: R.sans,
        fontWeight: 600,
        fontSize: 13,
        color: R.ink2,
        background: "transparent",
        border: `1px solid ${R.controlBorder}`,
        borderRadius: RADIUS.button,
        padding: "8px 14px",
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ── An inline rust link/affordance (rule 6): a link, or a low-key text action.
export function RustLink({
  children,
  onClick,
  type = "button",
  title,
  style,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  title?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      style={{
        fontFamily: R.sans,
        fontWeight: 600,
        fontSize: 12.5,
        color: R.rust,
        background: "none",
        border: "none",
        padding: 0,
        cursor: "pointer",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

// ── The flat outer panel (rule 3): one surface, 1px frame, radius 4, no shadow.
//    Use for the whole content plane; group INSIDE it with hairlines, not nested panels.
export function Panel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: R.surface, border: `1px solid ${R.frame}`, borderRadius: RADIUS.panel, ...style }}>
      {children}
    </div>
  );
}

// ── Product image slot (rule 7): 92×92, radius 3. In production this is the real
//    Shopify product image. We must NOT ship the designer's drop-placeholder; when
//    there is no real image we render an honest neutral swatch with the product's
//    initial, never a fake photo.
export function ImageSlot({
  src,
  alt,
  size = 92,
  initial,
}: {
  src?: string | null;
  alt: string;
  size?: number;
  initial?: string;
}) {
  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        width={size}
        height={size}
        style={{ flex: "none", width: size, height: size, objectFit: "cover", borderRadius: 3, display: "block", background: R.wash }}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      style={{
        flex: "none",
        width: size,
        height: size,
        borderRadius: 3,
        background: R.wash,
        border: `1px solid ${R.hairline}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: R.label,
        fontFamily: R.sans,
        fontWeight: 600,
        fontSize: Math.round(size / 3.6),
      }}
    >
      {(initial || alt || "·").trim().charAt(0).toUpperCase()}
    </div>
  );
}
