# slack-manifest

Manage Jefe's Slack app configuration (scopes, event subscriptions, the Messages
tab) from the CLI via Slack's **App Manifest API** — so nobody has to click around
the Slack dashboard.

- **App:** `A0BK3B6JKL5` ("my name jefe") in the **Quiver** workspace (`T01LYST3F7X`).
  Override with `SLACK_APP_ID`. (Note: `A0BKHK5UALV` is a *different, wrong* app id
  seen in an old screenshot — do not use it.)
- The Slack app id is **not** used by the running app; the app authenticates via
  OAuth `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET`. This tool is operator-only.

## Auth

Uses Slack **app-configuration tokens** (not the bot token). Access tokens live
~12h; the tool rotates them itself via the refresh token and persists the fresh
pair to a store **outside the repo**:

    ~/.claude-personal/.slack-config-tokens.json   (mode 600, git-ignored, never committed)

Override the path with `SLACK_TOKEN_STORE`. First run only, bootstrap from env
(get fresh tokens from https://api.slack.com/apps → "Your App Configuration Tokens"):

    SLACK_BOOTSTRAP_ACCESS=xoxe.xoxp-… SLACK_BOOTSTRAP_REFRESH=xoxe-1-… node tools/slack-manifest/manifest.mjs status

After that it is self-sustaining (rotates as needed).

## Commands

    node tools/slack-manifest/manifest.mjs status     # print the parts that matter
    node tools/slack-manifest/manifest.mjs dump        # full live manifest JSON
    node tools/slack-manifest/manifest.mjs enable-messages   # allow users to DM the bot
    node tools/slack-manifest/manifest.mjs provision   # Messages tab + ensure the bot
                                                        # scopes the code requests
                                                        # (DEFAULT_SLACK_SCOPES + im:history)

`provision` is **additive** — it never removes an already-granted scope. Changing
scopes requires the workspace install to be **reconnected** to grant them to the
live bot token.

## Least privilege

Only add scopes the code actually uses (`DEFAULT_SLACK_SCOPES` in
`apps/shopify/app/lib/channels/slack.server.js` + `im:history` for `message.im`
events). Do not broaden beyond that without a reason recorded here.
