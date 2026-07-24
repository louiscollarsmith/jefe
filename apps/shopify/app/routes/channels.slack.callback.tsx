import type { LoaderFunctionArgs } from "react-router";

import prisma from "../db.server";
import {
  channelActionError,
  completeSlackConnectionFromState,
  getSlackReturnPathForState,
} from "../lib/channels/service.server.js";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const returnPath = await getSlackReturnPathForState(prisma, { state });

  try {
    await completeSlackConnectionFromState(prisma, {
      state,
      code: url.searchParams.get("code"),
      error: url.searchParams.get("error"),
    });
    return slackCallbackResponse(
      appPathWithChannelNotice(returnPath, {
        channelNotice: "slack_connected",
      }),
      "Slack connected",
      "Return to Jefe to choose the channel I should use.",
    );
  } catch (error) {
    return slackCallbackResponse(
      appPathWithChannelNotice(returnPath, {
        channelNotice: channelActionError(error).code,
      }),
      "Slack connection needs attention",
      channelActionError(error).message,
    );
  }
};

function slackCallbackResponse(returnPath: string, title: string, message: string) {
  const safeReturnPath = JSON.stringify(returnPath);
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);

  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <style>
      :root {
        color: #17202f;
        background: #f8f3ea;
        font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        align-items: center;
        display: flex;
        justify-content: center;
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }
      main {
        background: #fffdf8;
        border: 1px solid rgba(23, 32, 47, 0.14);
        border-radius: 8px;
        box-shadow: 0 16px 48px rgba(23, 32, 47, 0.12);
        max-width: 420px;
        padding: 28px;
        text-align: center;
      }
      h1 {
        font-family: Georgia, "Times New Roman", serif;
        font-size: 28px;
        font-weight: 500;
        line-height: 1.15;
        margin: 0 0 12px;
      }
      p {
        color: rgba(23, 32, 47, 0.72);
        font-size: 15px;
        line-height: 1.5;
        margin: 0;
      }
      a {
        color: #0b5cab;
        display: inline-block;
        font-weight: 650;
        margin-top: 20px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${safeTitle}</h1>
      <p>${safeMessage}</p>
      <a href="${escapeAttribute(returnPath)}">Return to Jefe</a>
    </main>
    <script>
      const returnPath = ${safeReturnPath};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.location.href = new URL(returnPath, window.location.origin).toString();
          window.close();
        }
      } catch (error) {
        // Keep the readable fallback page visible when browser popup rules block access.
      }
    </script>
  </body>
</html>`,
    {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/html;charset=utf-8",
      },
    },
  );
}

function appPathWithChannelNotice(
  path: string,
  updates: Record<string, string | null>,
) {
  const url = new URL(path, "https://jefe.local");
  url.searchParams.delete("code");
  url.searchParams.delete("error");
  url.searchParams.delete("state");
  url.searchParams.set("step", "channels");
  url.searchParams.set("channelProvider", "slack");
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  const search = url.searchParams.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
