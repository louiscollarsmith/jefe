import { useLocation, type MetaFunction } from "react-router";
import { DailyHome } from "../components/daily-home";
import { SAMPLE_APP_HOME } from "../components/app-home/sample";
import { R } from "../components/app-home/register";

// Public design-preview of the redesigned app home in the "13a" register — a review asset
// like /cinematic and /daily. It renders the REAL production components (AppHome13a +
// sections + primitives) with illustrative sample data, so what you review here is the
// actual component output, not a throwaway mock. Public (no auth, no App Bridge), never
// shown to a merchant; the sample "Everdew" data is illustrative.
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
  const location = useLocation();
  const actionChatId = new URLSearchParams(location.search).get("actionChat");
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
        Design preview · /app-home-13a · Home Brief register · illustrative Everdew data - not merchant-facing
      </div>
      <div style={{ maxWidth: 1180, margin: "16px auto", background: R.surface, border: `1px solid ${R.frame}`, borderRadius: 4, overflow: "hidden" }}>
        <DailyHome
          {...SAMPLE_APP_HOME}
          insights={[]}
          channels={[]}
          actionChatId={actionChatId}
          actionChatThread={{ topic: actionChatId ? `action:${actionChatId}` : null, messages: [] }}
        />
      </div>
    </div>
  );
}
