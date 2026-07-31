import type { MetaFunction } from "react-router";
import { AppHome13a } from "../components/app-home/AppHome13a";
import { SAMPLE_APP_HOME } from "../components/app-home/sample";
import { R } from "../components/app-home/register";

// Public design-preview of the redesigned app home in the "13a" register — a review asset
// like /cinematic and /daily. It renders the REAL production components (AppHome13a +
// sections + primitives) with illustrative sample data, so what you review here is the
// actual component output, not a throwaway mock. Public (no auth, no App Bridge), never
// shown to a merchant; the sample "Everdew" data is the handoff's, chosen to prove the
// register on a THIN store.
//
// It's a normal hydrated route so section-switching works and the wired <Form> controls
// have router context. The no-op action below keeps the preview's mode-picker POSTs inert
// (in the live app those intents are handled by app._index). Not adopted into the live
// home yet — see QUESTIONS-FOR-MATT.md.

export const meta: MetaFunction = () => [
  { title: "Jefe — app home (13a preview)" },
  { name: "robots", content: "noindex" },
];

export async function action() {
  // Preview only: swallow mode-picker / form POSTs so nothing 405s.
  return null;
}

export default function AppHome13aPreview() {
  return (
    <div style={{ minHeight: "100vh", background: "#e8e4dd" }}>
      <div
        style={{
          fontFamily: R.mono,
          fontSize: 11,
          letterSpacing: "0.3px",
          color: R.metaMono,
          padding: "10px 16px",
          textAlign: "center",
          background: "#efe9df",
          borderBottom: `1px solid ${R.frame}`,
        }}
      >
        Design preview · /app-home-13a · 13a visual register · illustrative “Everdew” data — not merchant-facing, forms inert
      </div>
      <div style={{ maxWidth: 1180, margin: "16px auto", background: R.surface, border: `1px solid ${R.frame}`, borderRadius: 4, overflow: "hidden" }}>
        <AppHome13a {...SAMPLE_APP_HOME} />
      </div>
    </div>
  );
}
