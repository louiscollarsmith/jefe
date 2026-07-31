/**
 * Public "What's new" page — merchant-facing product updates in Jefe's voice.
 *
 * GET /whats-new → a curated, honest summary of what's shipped for merchants.
 * This is NOT the engineer-facing CHANGELOG.md; it's a hand-written, in-voice
 * digest a merchant would actually want to read.
 *
 * Ships DARK behind ENABLE_PUBLIC_CHANGELOG (404 when off), so it deploys
 * without being exposed — a human reviews/edits the copy and flips the flag +
 * links it when ready. Not embedded/authenticated — a public surface.
 *
 * First-pass copy (2026-07-30) is deliberately conservative + honest: it
 * describes only what a merchant can actually see today, and frames the
 * action layer as advisory ("suggests", "you approve") — never claims Jefe
 * acts on its own while execution is still gated.
 */

// Single source of truth for merchant-facing product news — shared with the
// app-home "New in Jefe" rail so the two never drift.
import { WHATS_NEW_ENTRIES } from "../lib/notifications/whats-new.server.js";

function isPublicChangelogEnabled(): boolean {
  return (
    String(process.env.ENABLE_PUBLIC_CHANGELOG ?? "").trim().toLowerCase() === "true"
  );
}

export const loader = async () => {
  // Dark until a human flips the flag: unexposed pages 404 rather than leak a
  // half-reviewed public surface.
  if (!isPublicChangelogEnabled()) return htmlResponse(notFoundPage(), 404);
  return htmlResponse(changelogPage());
};

function htmlResponse(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Not indexed while the surface is new; a human decides SEO exposure later.
      "x-robots-tag": "noindex",
    },
  });
}

function changelogPage(): string {
  const items = WHATS_NEW_ENTRIES.map(
    (e) => `
      <li class="entry">
        <div class="date">${e.date}</div>
        <h2>${e.title}</h2>
        <p>${e.body}</p>
      </li>`,
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>What's new · Jefe</title>
<style>
  :root{--cream:#ece5da;--card:#fffcf7;--navy:#1b2338;--ink:#232a3d;--body:#4a5165;--muted:#8b8f9d;--line:#e7e0d5;--accent:#8c4030;}
  *{box-sizing:border-box;}
  body{margin:0;background:var(--cream);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;line-height:1.55;}
  .wrap{max-width:640px;margin:0 auto;padding:40px 20px 72px;}
  header{background:var(--navy);border-radius:14px;padding:26px 30px;color:#f8ece7;}
  header .eyebrow{font-size:11px;letter-spacing:1.6px;text-transform:uppercase;color:#9aa6c4;margin-bottom:8px;}
  header h1{margin:0;font-family:Georgia,'Times New Roman',serif;font-size:34px;font-weight:normal;letter-spacing:-0.3px;}
  ul{list-style:none;margin:22px 0 0;padding:0;}
  .entry{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:22px 24px;margin-bottom:14px;}
  .entry .date{font-size:11px;letter-spacing:1.4px;text-transform:uppercase;color:var(--accent);margin-bottom:8px;}
  .entry h2{margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-size:22px;font-weight:normal;color:var(--ink);}
  .entry p{margin:0;font-size:15.5px;color:var(--body);}
  footer{margin-top:26px;text-align:center;font-size:13px;color:var(--muted);}
  footer a{color:var(--muted);}
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="eyebrow">What's new</div>
      <h1>How Jefe's been getting better</h1>
    </header>
    <ul>${items}</ul>
    <footer>Jefe · <a href="https://mynamejefe.com">mynamejefe.com</a></footer>
  </div>
</body>
</html>`;
}

function notFoundPage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" /><title>Not found</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:#ece5da;color:#4a5165;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;}</style>
</head><body><p>Nothing here yet.</p></body></html>`;
}
