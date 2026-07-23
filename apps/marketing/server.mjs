import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

const sql = neon(DATABASE_URL);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

async function notifySlack(email, storeUrl) {
  if (!SLACK_WEBHOOK_URL) return;

  const text = storeUrl
    ? `:wave: New Design Partner signup — *${email}* (${storeUrl})`
    : `:wave: New Design Partner signup — *${email}* (no store URL given)`;

  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error("slack notify failed", res.status, await res.text());
    }
  } catch (err) {
    console.error("slack notify failed", err);
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/waitlist", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const storeUrl = String(req.body?.storeUrl || "").trim().slice(0, 320) || null;
  const honeypot = req.body?.company;

  if (honeypot) {
    // Bot filled the hidden field. Pretend success, do nothing.
    return res.json({ ok: true });
  }

  if (!email || !EMAIL_RE.test(email) || email.length > 320) {
    return res.status(400).json({ ok: false, error: "Enter a valid email address." });
  }

  try {
    const [row] = await sql`
      INSERT INTO waitlist_signups (email, source, store_url)
      VALUES (${email}, 'mynamejefe.com', ${storeUrl})
      ON CONFLICT (email) DO UPDATE SET store_url = COALESCE(waitlist_signups.store_url, EXCLUDED.store_url)
      RETURNING (xmax = 0) AS inserted
    `;

    if (row?.inserted) {
      notifySlack(email, storeUrl);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("waitlist insert failed", err);
    return res.status(500).json({ ok: false, error: "Something went wrong. Try again shortly." });
  }
});

app.listen(PORT, () => {
  console.log(`jefe-marketing listening on ${PORT}`);
});
