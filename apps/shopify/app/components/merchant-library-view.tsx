import { Form, Link, useNavigation } from "react-router";
import type { CSSProperties } from "react";

import { formatDateInZone } from "../lib/home/home-dates.js";

// The Jefe Library — files the merchant chose to keep, and what Jefe read out of each one.
//
// ⭐ Showing the EXTRACT, not just the filename, is the point. "invoice-april.pdf" tells a
// merchant nothing about whether Jefe understood it; the first line of what Jefe read tells them
// immediately, and lets them delete a misread file rather than discover it in bad advice later.
//
// ⛔ The copy must not imply privacy. Keeping a file is about whether Jefe can point at it again
// — it is NOT "this stays private". Both keeping and discarding send the file to a model to be
// read. See the trap section in docs/rich-content-direction.md.

export type LibraryFile = {
  id: string;
  filename: string;
  mimeType: string;
  kind: string;
  byteSize: number;
  extractedText: string;
  source: string;
  conversationId: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

export function MerchantLibraryView({
  storeName,
  files,
  storeTimeZone,
}: {
  storeName: string;
  files: LibraryFile[];
  // Nullable on purpose: a shop whose zone we have not learned yet falls back inside
  // formatDateInZone, which is the ONE place that owns the service default (Europe/London).
  // Defaulting here as well would be a second definition of the service zone.
  storeTimeZone: string | null;
}) {
  const navigation = useNavigation();
  const deletingId =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "library.delete"
      ? String(navigation.formData.get("fileId") ?? "")
      : null;

  return (
    <main style={pageStyle}>
      <div style={shellStyle}>
        <div style={topStyle}>
          <Link to="/app" style={backLinkStyle}>
            ← Back
          </Link>
          <span style={storeStyle}>{storeName}</span>
        </div>

        <h1 style={headlineStyle}>Your library</h1>
        <p style={introStyle}>
          Files you asked me to keep. I can look at any of these again when you point me at
          them. Anything you send without keeping is read once and not stored.
        </p>

        {files.length === 0 ? (
          <div style={emptyStyle}>
            <p style={emptyTitleStyle}>Nothing kept yet</p>
            <p style={emptyBodyStyle}>
              When you send me a file in chat, tick <strong>Keep this file</strong> and it will
              show up here — a cost sheet, a supplier invoice, a stock count.
            </p>
          </div>
        ) : (
          <ul style={listStyle}>
            {files.map((file) => (
              <li key={file.id} style={itemStyle}>
                <div style={itemHeadStyle}>
                  <span style={nameStyle}>{file.filename}</span>
                  <span style={metaStyle}>
                    {formatBytes(file.byteSize)} ·{" "}
                    {/* The SERVICE's timezone, always — an ops or merchant reader in another
                        country must not see a different date for the same file. */}
                    {formatDateInZone({ iso: file.createdAt, timeZone: storeTimeZone })}
                  </span>
                </div>
                <p style={extractStyle}>{firstLines(file.extractedText)}</p>
                <div style={itemFootStyle}>
                  <span style={kindStyle}>{describeKind(file.kind)}</span>
                  <div style={itemActionsStyle}>
                    {/* Their own file back. `reloadDocument` because this is a byte response,
                        not a route the client router can render. */}
                    <Link
                      to={`/app/library/${file.id}/download`}
                      reloadDocument
                      style={downloadStyle}
                    >
                      Download
                    </Link>
                  <Form method="post" replace>
                    <input type="hidden" name="intent" value="library.delete" />
                    <input type="hidden" name="fileId" value={file.id} />
                    <button
                      type="submit"
                      style={deleteStyle}
                      disabled={deletingId === file.id}
                    >
                      {deletingId === file.id ? "Removing…" : "Remove"}
                    </button>
                  </Form>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

/** Enough to recognise the file by, without turning the list into a wall of OCR. */
function firstLines(text: string): string {
  const cleaned = String(text ?? "").trim();
  if (!cleaned) return "I couldn't read anything out of this one.";
  const lines = cleaned.split("\n").slice(0, 3).join(" · ");
  return lines.length > 240 ? `${lines.slice(0, 237)}…` : lines;
}

function describeKind(kind: string): string {
  if (kind === "spreadsheet") return "Spreadsheet";
  if (kind === "text") return "Data file";
  if (kind === "word") return "Document";
  if (kind === "image") return "Photo";
  if (kind === "document") return "PDF";
  return "File";
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const COLORS = {
  page: "#f6f3ee",
  card: "#fffdfa",
  border: "#d8d0c8",
  navy: "#1f3a63",
  muted: "#6d7175",
};
const FONT = {
  sans: "'Schibsted Grotesk', system-ui, -apple-system, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace",
};

const pageStyle: CSSProperties = {
  background: COLORS.page,
  fontFamily: FONT.sans,
  minHeight: "100vh",
  padding: "28px 20px 60px",
};
const shellStyle: CSSProperties = { margin: "0 auto", maxWidth: 720 };
const topStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 24,
};
const backLinkStyle: CSSProperties = {
  color: COLORS.navy,
  fontSize: 14,
  textDecoration: "none",
};
const storeStyle: CSSProperties = {
  color: COLORS.muted,
  fontFamily: FONT.mono,
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};
const headlineStyle: CSSProperties = {
  color: COLORS.navy,
  fontFamily: FONT.serif,
  fontSize: 32,
  fontWeight: 400,
  margin: "0 0 8px",
};
const introStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 15,
  lineHeight: 1.5,
  margin: "0 0 28px",
  maxWidth: 560,
};
const listStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  listStyle: "none",
  margin: 0,
  padding: 0,
};
const itemStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px solid ${COLORS.border}`,
  borderRadius: 12,
  padding: "16px 18px",
};
const itemHeadStyle: CSSProperties = {
  alignItems: "baseline",
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  justifyContent: "space-between",
};
const nameStyle: CSSProperties = {
  color: COLORS.navy,
  fontSize: 15,
  fontWeight: 500,
  overflowWrap: "anywhere",
};
const metaStyle: CSSProperties = {
  color: COLORS.muted,
  fontFamily: FONT.mono,
  fontSize: 11,
};
const extractStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 14,
  lineHeight: 1.5,
  margin: "8px 0 12px",
  overflowWrap: "anywhere",
};
const itemFootStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  justifyContent: "space-between",
};
const kindStyle: CSSProperties = {
  color: COLORS.muted,
  fontFamily: FONT.mono,
  fontSize: 11,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};
const itemActionsStyle: CSSProperties = {
  alignItems: "center",
  display: "flex",
  gap: 14,
};
const downloadStyle: CSSProperties = {
  color: COLORS.muted,
  fontFamily: FONT.sans,
  fontSize: 13,
  textDecoration: "underline",
};
const deleteStyle: CSSProperties = {
  background: "transparent",
  border: "none",
  color: COLORS.muted,
  cursor: "pointer",
  fontFamily: FONT.sans,
  fontSize: 13,
  padding: "2px 4px",
  textDecoration: "underline",
};
const emptyStyle: CSSProperties = {
  background: COLORS.card,
  border: `1px dashed ${COLORS.border}`,
  borderRadius: 12,
  padding: "32px 24px",
  textAlign: "center",
};
const emptyTitleStyle: CSSProperties = {
  color: COLORS.navy,
  fontFamily: FONT.serif,
  fontSize: 20,
  margin: "0 0 8px",
};
const emptyBodyStyle: CSSProperties = {
  color: COLORS.muted,
  fontSize: 14,
  lineHeight: 1.5,
  margin: 0,
};
