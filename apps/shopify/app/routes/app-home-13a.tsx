import { type MetaFunction } from "react-router";
import { DailyHome } from "../components/daily-home";
import { SAMPLE_APP_HOME } from "../components/app-home/sample";
import { R } from "../components/app-home/register";

// Public design-preview of the app home — a review asset like /cinematic and /daily. It
// renders the REAL production DailyHome brief with illustrative sample data, so what you
// review here is the actual component output, not a throwaway mock. Public (no auth, no
// App Bridge), never shown to a merchant; the sample "Everdew" data is illustrative.
// (The "13a" AppHome13a shell is shelved, not deleted — the live home is the DailyHome brief.)
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

const PREVIEW_ACTIONS = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Secure Stock on Fast-Selling Drinks",
    summary:
      "Review products currently facing low stock cover and initiate replenishment orders to prevent stockouts on popular specialist beverages.",
    status: "proposed",
    statusLabel: "Proposed",
    sourceRecommendationId: "33333333-3333-4333-8333-333333333333",
    actionRunId: "11111111-1111-4111-8111-111111111111",
    actionType: "stock_replenishment",
    executable: false,
    displaySteps: [
      { label: "Check the two products with lowest stock cover." },
      { label: "Confirm supplier lead time before any reorder." },
    ],
    baselineSignal: "2 products",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "Archive dead listings",
    summary: "Remove live products with no stock and no recent sales from the storefront.",
    status: "in_progress",
    statusLabel: "In progress",
    actionRunId: "22222222-2222-4222-8222-222222222222",
    actionType: "tidy_up",
    executable: true,
  },
];

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
        Design preview · /app-home-13a · Home Brief register · illustrative
        Everdew data - not merchant-facing
      </div>
      <div
        style={{
          maxWidth: 1180,
          margin: "16px auto",
          background: R.surface,
          border: `1px solid ${R.frame}`,
          borderRadius: 4,
          overflow: "hidden",
        }}
      >
        <DailyHome
          {...SAMPLE_APP_HOME}
          insights={[]}
          channels={[]}
          merchantActions={PREVIEW_ACTIONS}
          conversation={{
            conversation: null,
            conversations: [
              {
                id: "preview-chat-1",
                conversationType: "general",
                surface: "app",
                title: "Reorder timing",
                lastMessageAt: "2026-08-13T09:20:00.000Z",
                createdAt: "2026-08-13T09:10:00.000Z",
                focusedActionId: PREVIEW_ACTIONS[0].id,
                focusedAction: {
                  id: PREVIEW_ACTIONS[0].id,
                  title: PREVIEW_ACTIONS[0].title,
                  summary: PREVIEW_ACTIONS[0].summary,
                  status: PREVIEW_ACTIONS[0].status,
                  sourceRecommendationId:
                    PREVIEW_ACTIONS[0].sourceRecommendationId,
                  actionRunId: PREVIEW_ACTIONS[0].actionRunId,
                },
              },
            ],
            messages: [],
          }}
        />
      </div>
    </div>
  );
}
