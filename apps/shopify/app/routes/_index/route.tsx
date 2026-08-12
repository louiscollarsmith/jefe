import { useRef, useState } from "react";
import type {
  LinksFunction,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Jefe — Early Access" },
  {
    name: "description",
    content:
      "Jefe learns how your Shopify store actually works, finds your next move, and — on your terms — acts on it. Invite only, for now.",
  },
];

// Web fonts for the early-access design. Loaded via the route `links` export so
// they land in <head> (root renders <Links/>), preconnected for speed.
export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Schibsted+Grotesk:wght@400;500;600;700&family=Bricolage+Grotesque:wght@600;700&family=IBM+Plex+Mono:wght@400;500&display=swap",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Preserve embedded deep-links: an inbound `?shop=` (Shopify admin entry, and
  // what the welcome email appends to deep-link a merchant straight into their
  // embedded app) hands off to the app shell. Everything else gets the
  // early-access landing below, whose form signs the merchant in via the
  // managed Shopify OAuth entry (`/auth/login`).
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

// Normalise: merchants paste the whole URL. Lowercase, strip protocol, path and
// a trailing `.myshopify.com` → leaves the store handle. Shape-only check;
// whether the store exists is Shopify's to answer.
function normalise(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/, "");
}
function validHandle(store: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(store);
}

/**
 * Standalone front door at `app.mynamejefe.com` (logged out). This is the SAME
 * page and SAME flow as `mynamejefe.com/early-access` — one consistent entry:
 * enter a store handle → managed Shopify OAuth (`/auth/login`) → the app. The
 * design mirrors /early-access exactly (navy / Instrument-Serif register). The
 * standalone-session sign-in (`/standalone/auth` + `standalone.callback`) is
 * left in place but intentionally not wired here until that feature ships.
 */
export default function Index() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  function submit() {
    if (submitting) return;
    const store = normalise(inputRef.current?.value ?? "");
    if (!validHandle(store)) {
      setError(true);
      inputRef.current?.focus();
      return;
    }
    setError(false);
    setSubmitting(true);
    window.location.href = `/auth/login?shop=${store}.myshopify.com`;
  }

  return (
    <main className="EA">
      <style dangerouslySetInnerHTML={{ __html: EA_CSS }} />
      <div className="EA-wrap">
        <nav className="EA-nav">
          <span className="EA-brand">
            <svg viewBox="0 0 64 64" aria-hidden="true">
              <rect width="64" height="64" rx="16" fill="#33456b" />
              <path
                d="M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z"
                fill="#f8ece7"
              />
              <circle cx="32" cy="49" r="4.5" fill="#c98a8a" />
            </svg>
            <span className="EA-wordmark">Jefe</span>
          </span>
          <span className="EA-pill">Early access</span>
        </nav>

        <section className="EA-hero">
          <h1 className="EA-h1">Your AI eCommerce manager.</h1>
          <div className="EA-italic">Invite only — for now.</div>
          <p className="EA-lede">
            Jefe learns how your Shopify store actually works, finds your next
            move, and — on your terms — acts on it. You&rsquo;re one of a small
            group getting it early.
          </p>
        </section>

        <div className="EA-card">
          <label className="EA-cardLabel" htmlFor="shop">
            Connect your Shopify store
          </label>
          <div className={error ? "EA-field EA-field--error" : "EA-field"}>
            <input
              ref={inputRef}
              id="shop"
              type="text"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="yourstore"
              aria-describedby="ea-err"
              aria-invalid={error}
              onInput={() => {
                if (error) setError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            <span className="EA-suffix">.myshopify.com</span>
          </div>
          <div
            className={error ? "EA-err EA-err--show" : "EA-err"}
            id="ea-err"
            role="alert"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M8 4.6v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="8" cy="11.4" r="0.95" fill="currentColor" />
            </svg>
            <span>That doesn&rsquo;t look like a .myshopify.com store — check and try again.</span>
          </div>
          <div className="EA-ctaRow">
            <button className="EA-cta" type="button" onClick={submit} disabled={submitting}>
              {submitting ? (
                <>
                  <span className="EA-spin" aria-hidden="true" />
                  <span>Taking you to Shopify…</span>
                </>
              ) : (
                <span>Connect store</span>
              )}
            </button>
            {!submitting && (
              <span className="EA-micro">
                Two minutes, and it&rsquo;s free while we&rsquo;re in early access.
              </span>
            )}
          </div>
        </div>

        <div className="EA-steps">
          <div className="EA-step">
            <span className="EA-n">01</span>
            <span className="EA-t">Shopify asks you to approve the permissions Jefe needs.</span>
          </div>
          <div className="EA-step">
            <span className="EA-n">02</span>
            <span className="EA-t">Jefe reads your store. Nothing changes while he reads.</span>
          </div>
          <div className="EA-step">
            <span className="EA-n">03</span>
            <span className="EA-t">
              You pick the mode per action: recommend, approve then execute, or fully autonomous.
            </span>
          </div>
          <div className="EA-scopes">
            He reads your orders, products, customers, inventory and locations, and can act
            on your store on your behalf — today that&rsquo;s product changes, like marking
            down slow-moving stock. He never emails your customers, and every change is
            previewed first and reversible after.
          </div>
        </div>

        <section className="EA-contact">
          <div className="EA-rule">
            <div className="EA-contactBody">
              Matt and Louis built Jefe, and you can reach either of us directly while
              we&rsquo;re this small. If something breaks, or Jefe makes a call you disagree
              with, we want to hear it the same day.
            </div>
            <div className="EA-mail">
              <a href="mailto:hola@mynamejefe.com">hola@mynamejefe.com</a>
            </div>
          </div>
        </section>

        <div className="EA-trust">
          Your data is used to run Jefe for you — we never sell it.{" "}
          <a href="https://mynamejefe.com/privacy">Privacy</a> ·{" "}
          <a href="https://mynamejefe.com/terms">Terms</a> ·{" "}
          <a href="https://mynamejefe.com/dpa">DPA</a>
        </div>

        <div className="EA-foot">
          <span className="EA-wordmark">Jefe</span>
        </div>
      </div>
    </main>
  );
}

const EA_CSS = `
.EA { min-height: 100dvh; background: #fdfbf7; font-family: 'Schibsted Grotesk', system-ui, sans-serif; color: oklch(0.30 0.02 55); -webkit-font-smoothing: antialiased; }
.EA *, .EA *::before, .EA *::after { box-sizing: border-box; }
.EA a { color: oklch(0.42 0.07 262); }
.EA a:hover { color: oklch(0.30 0.06 262); }
.EA ::selection { background: oklch(0.42 0.07 262); color: oklch(0.97 0.01 80); }
.EA input::placeholder { color: oklch(0.64 0.015 262); }
@keyframes eaSpin { to { transform: rotate(360deg); } }
.EA-wrap { max-width: 660px; margin: 0 auto; padding-inline: clamp(20px, 5vw, 30px); }
.EA-nav { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding-block: 20px; border-bottom: 1px solid oklch(0.90 0.008 70); }
.EA-brand { display: flex; align-items: center; gap: 8px; }
.EA-brand svg { width: 24px; height: 24px; display: block; }
.EA-wordmark { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 600; font-size: 21px; letter-spacing: 0.2px; color: oklch(0.30 0.06 262); }
.EA-pill { font-size: 13px; color: oklch(0.44 0.05 68); border-bottom: 2px solid oklch(0.76 0.09 78); padding-bottom: 1px; }
.EA-hero { padding-top: clamp(30px, 5vw, 42px); }
.EA-h1 { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; font-size: clamp(31px, 6.2vw, 43px); line-height: 1.06; letter-spacing: -1.1px; margin: 0; color: oklch(0.27 0.055 262); text-wrap: balance; }
.EA-italic { font-family: 'Instrument Serif', serif; font-style: italic; font-size: clamp(21px, 4vw, 27px); line-height: 1.2; margin-top: 7px; color: oklch(0.54 0.09 22); }
.EA-lede { font-size: clamp(15.5px, 2.2vw, 16.5px); line-height: 1.6; color: oklch(0.38 0.014 55); margin: 18px 0 0; max-width: 540px; text-wrap: pretty; }
.EA-card { border: 1px solid oklch(0.80 0.025 262); border-radius: 6px; padding: clamp(20px, 4vw, 26px); background: oklch(0.998 0.003 80); margin-top: clamp(26px, 4vw, 34px); }
.EA-cardLabel { display: block; font-size: 15px; font-weight: 700; color: oklch(0.25 0.035 262); }
.EA-field { display: flex; align-items: stretch; margin-top: 12px; border: 1.5px solid oklch(0.78 0.02 262); border-radius: 5px; background: #fff; overflow: hidden; transition: border-color .12s; }
.EA-field--error { border-color: oklch(0.62 0.15 25); }
.EA-field input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; font-family: 'Schibsted Grotesk', sans-serif; font-size: 16px; color: oklch(0.22 0.02 40); padding: 13px 2px 13px 13px; }
.EA-suffix { display: flex; align-items: center; padding: 0 13px 0 0; font-size: 15.5px; color: oklch(0.48 0.015 262); white-space: nowrap; user-select: none; }
.EA-err { display: none; align-items: flex-start; gap: 7px; margin-top: 9px; font-size: 14px; line-height: 1.45; color: oklch(0.46 0.14 25); }
.EA-err--show { display: flex; }
.EA-err svg { flex: none; width: 15px; height: 15px; margin-top: 2px; }
.EA-ctaRow { display: flex; align-items: center; flex-wrap: wrap; gap: 16px; margin-top: 14px; }
.EA-cta { font-family: 'Bricolage Grotesque', sans-serif; font-weight: 700; font-size: 15.5px; color: #fdfbf7; background: oklch(0.34 0.065 262); border: 0; border-radius: 5px; padding: 12px 22px; cursor: pointer; display: inline-flex; align-items: center; gap: 10px; }
.EA-cta:hover { background: oklch(0.30 0.06 262); }
.EA-cta[disabled] { opacity: .8; cursor: default; }
.EA-spin { width: 15px; height: 15px; border: 2px solid oklch(0.97 0.01 80 / 0.3); border-top-color: oklch(0.97 0.01 80); border-radius: 50%; animation: eaSpin .7s linear infinite; display: inline-block; }
.EA-micro { font-size: 13.5px; line-height: 1.5; color: oklch(0.46 0.015 55); }
.EA-steps { margin-top: 20px; }
.EA-step { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 14px; padding: 12px 0; border-top: 1px solid oklch(0.90 0.008 70); }
.EA-step:last-of-type { border-bottom: 1px solid oklch(0.90 0.008 70); }
.EA-n { width: 22px; flex: none; font-family: 'IBM Plex Mono', monospace; font-size: 12px; color: oklch(0.54 0.09 22); }
.EA-t { flex: 1 1 240px; min-width: 220px; font-size: 14.5px; line-height: 1.5; color: oklch(0.30 0.02 55); }
.EA-scopes { font-size: 13.5px; line-height: 1.55; color: oklch(0.46 0.015 55); margin-top: 12px; }
.EA-contact { padding-top: clamp(30px, 5vw, 40px); }
.EA-rule { border-left: 3px solid oklch(0.34 0.065 262); padding-left: 14px; }
.EA-contactBody { font-size: 14.5px; line-height: 1.6; color: oklch(0.34 0.02 55); }
.EA-mail { font-size: 13.5px; margin-top: 7px; }
.EA-trust { font-size: 13px; line-height: 1.55; color: oklch(0.46 0.015 55); border-top: 1px solid oklch(0.90 0.008 70); padding-top: 14px; margin-top: clamp(28px, 4vw, 36px); }
.EA-foot { padding: 22px 0 40px; }
.EA-foot .EA-wordmark { font-size: 16px; color: oklch(0.42 0.04 262); }
@media (prefers-reduced-motion: reduce) { .EA-spin { animation: none; } }
`;
