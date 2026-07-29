import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";

export const meta: MetaFunction = () => [
  { title: "Jefe — your eCommerce manager" },
  {
    name: "description",
    content:
      "Jefe connects to your Shopify store and builds a living, structured memory of how it really runs — so the plan you get back is one you'd call your own.",
  },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  // Preserve embedded deep-links: an inbound `?shop=` (Shopify admin entry, and
  // what the welcome email can append to deep-link a merchant straight into
  // their embedded app) hands off to the app shell. Everything else gets the
  // standalone landing below, whose form signs the merchant in out-of-iframe via
  // `/standalone/auth` (shop-domain OAuth → signed standalone session).
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function Index() {
  return (
    <main className="JefeLanding">
      <style dangerouslySetInnerHTML={{ __html: LANDING_CSS }} />
      <section className="JefeLanding__card">
        <span className="JefeLanding__mark" aria-hidden="true">
          <svg viewBox="0 0 64 64" role="presentation">
            <rect width="64" height="64" rx="16" fill="#33456b" />
            <path
              d="M28 16h11v26c0 8-5 12-13 12-4 0-7-1.5-9-4l5-6c1 1.3 2.5 2 4 2 2.5 0 2-3.5 2-6.5V16z"
              fill="#f8ece7"
            />
            <circle cx="32" cy="49" r="4.5" fill="#c98a8a" />
          </svg>
        </span>

        <p className="JefeLanding__eyebrow">Your eCommerce manager</p>

        <h1 className="JefeLanding__heading">
          I learn how your store actually works.
        </h1>

        <p className="JefeLanding__sub">
          Jefe connects to your Shopify store and builds a living, structured
          memory of how it really runs — the products, the customers, the
          rhythms — so the plan you get back is one you&rsquo;d call your own.
        </p>

        <form
          className="JefeLanding__form"
          method="post"
          action="/standalone/auth"
        >
          <input
            className="JefeLanding__input"
            type="text"
            name="shop"
            inputMode="url"
            autoComplete="on"
            placeholder="your-store.myshopify.com"
            aria-label="Your Shopify store domain"
          />
          <button className="JefeLanding__cta" type="submit">
            Open Jefe
          </button>
        </form>

        <p className="JefeLanding__helper">
          Enter your myshopify.com store to sign in — Jefe opens right here, or
          walks you through Shopify to connect if you&rsquo;re new.
        </p>

        <p className="JefeLanding__sign">— Jefe</p>
      </section>

      <footer className="JefeLanding__footer">
        <a href="mailto:hola@mynamejefe.com">hola@mynamejefe.com</a>
      </footer>
    </main>
  );
}

/**
 * Scoped, self-contained landing styles, kept inline in this one route so the
 * standalone front door stays atomic (no shared-CSS edit) while the full
 * standalone sign-in is built out. The palette, Georgia serif display and
 * warm first-person voice deliberately MIRROR the Day-0 welcome email
 * (`app/lib/email/templates/jefe-welcome.html`), which links here via its
 * "Watch me work" CTA — so the hop from inbox to web reads as one brand:
 * greige page #ece5da, cream card #fffcf7, ink #232a3d, terracotta accent
 * #8c4030, navy CTA #33456b (the email's button colour).
 */
const LANDING_CSS = `
.JefeLanding {
  box-sizing: border-box;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 40px 20px;
  background-color: #ece5da;
  color: #232a3d;
  font-family: "Schibsted Grotesk", system-ui, -apple-system, sans-serif;
}
.JefeLanding * { box-sizing: border-box; }
.JefeLanding__card {
  width: 100%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 48px 44px 40px;
  background-color: #fffcf7;
  border: 1px solid #efe6d9;
  border-radius: 16px;
  box-shadow: 0 24px 60px -30px rgba(35, 42, 61, 0.35);
}
.JefeLanding__mark {
  display: inline-flex;
  width: 54px;
  height: 54px;
  margin-bottom: 22px;
  filter: drop-shadow(0 12px 26px rgba(35, 42, 61, 0.18));
}
.JefeLanding__mark svg { width: 100%; height: 100%; display: block; }
.JefeLanding__eyebrow {
  margin: 0 0 16px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #8c4030;
}
.JefeLanding__heading {
  margin: 0;
  font-family: Georgia, "Times New Roman", serif;
  font-weight: 400;
  font-size: 40px;
  line-height: 1.12;
  letter-spacing: -0.01em;
  color: #232a3d;
}
.JefeLanding__sub {
  margin: 20px 0 0;
  max-width: 44ch;
  font-size: 17px;
  line-height: 1.55;
  color: #4a5165;
}
.JefeLanding__form {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  max-width: 380px;
  margin-top: 30px;
}
.JefeLanding__input {
  width: 100%;
  min-height: 48px;
  padding: 0 16px;
  border: 1px solid #d9cfc0;
  border-radius: 10px;
  background: #fffdfa;
  color: #232a3d;
  font-family: inherit;
  font-size: 15px;
  text-align: center;
}
.JefeLanding__input::placeholder { color: #a79f92; }
.JefeLanding__input:focus-visible {
  outline: 2px solid #8c4030;
  outline-offset: 1px;
  border-color: #8c4030;
}
.JefeLanding__cta {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 48px;
  padding: 0 30px;
  border: 0;
  border-radius: 10px;
  background: #33456b;
  color: #ffffff;
  font-family: inherit;
  font-size: 16px;
  font-weight: 700;
  text-decoration: none;
  cursor: pointer;
  box-shadow: 0 14px 30px -14px rgba(35, 42, 61, 0.75);
  transition: background 140ms ease, transform 140ms ease, box-shadow 140ms ease;
}
.JefeLanding__cta:hover {
  background: #2b3a5f;
  transform: translateY(-1px);
  box-shadow: 0 18px 34px -14px rgba(35, 42, 61, 0.8);
}
.JefeLanding__cta:focus-visible {
  outline: 2px solid #8c4030;
  outline-offset: 3px;
}
.JefeLanding__helper {
  margin: 18px 0 0;
  max-width: 40ch;
  font-size: 13.5px;
  line-height: 1.5;
  color: #6b7285;
}
.JefeLanding__sign {
  margin: 26px 0 0;
  padding-top: 20px;
  width: 100%;
  border-top: 1px solid #e7e0d5;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 17px;
  color: #232a3d;
}
.JefeLanding__footer {
  font-size: 12px;
  color: #8b8f9d;
}
.JefeLanding__footer a { color: #8b8f9d; text-decoration: none; }
.JefeLanding__footer a:hover { color: #8c4030; text-decoration: underline; }
@media (max-width: 600px) {
  .JefeLanding__card { padding: 36px 24px 32px; }
  .JefeLanding__heading { font-size: 32px; }
  .JefeLanding__sub { font-size: 16px; }
}
@media (prefers-reduced-motion: reduce) {
  .JefeLanding__cta { transition: none; }
  .JefeLanding__cta:hover { transform: none; }
}
`;
