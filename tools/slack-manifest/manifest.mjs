#!/usr/bin/env node
// @ts-check
/**
 * slack-manifest — manage the Jefe Slack app via the App Manifest API.
 *
 * Uses Slack *app-configuration tokens* (not the bot token). Config access
 * tokens live ~12h; this tool rotates them itself via the refresh token and
 * persists the fresh pair to a token store OUTSIDE the repo, so it keeps
 * working across sessions without anyone touching the Slack dashboard.
 *
 * The store never enters git. Bootstrapped once from env, then self-sustaining.
 *
 * Commands:
 *   status           export the live manifest and print the parts that matter
 *   dump             print the full live manifest JSON
 *   enable-messages  turn ON the Messages tab (allow users to DM the bot)
 *
 * Env (first run only): SLACK_BOOTSTRAP_ACCESS / SLACK_BOOTSTRAP_REFRESH
 */
import fs from "node:fs";
import os from "node:os";

const APP_ID = process.env.SLACK_APP_ID || "A0BK3B6JKL5";
const STORE =
  process.env.SLACK_TOKEN_STORE ||
  `${os.homedir()}/.claude-personal/.slack-config-tokens.json`;
const API = "https://slack.com/api";

const loadStore = () => {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
};
const saveStore = (obj) =>
  fs.writeFileSync(STORE, JSON.stringify(obj, null, 2), { mode: 0o600 });

async function slack(method, token, params) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: new URLSearchParams(params || {}),
  });
  return res.json();
}

async function rotate(refresh) {
  const r = await slack("tooling.tokens.rotate", null, { refresh_token: refresh });
  if (!r.ok) throw new Error(`rotate failed: ${r.error}`);
  saveStore({ token: r.token, refresh_token: r.refresh_token, exp: r.exp, team_id: r.team_id });
  return r.token;
}

/** Return a usable config access token, rotating/bootstrapping as needed. */
async function freshToken() {
  const store = loadStore();
  const now = Math.floor(Date.now() / 1000);
  if (store.token && store.exp && store.exp - now > 3600) return store.token;
  if (store.refresh_token) return rotate(store.refresh_token);

  // Bootstrap: prefer a still-valid access token, else rotate the refresh.
  const bootAccess = process.env.SLACK_BOOTSTRAP_ACCESS;
  const bootRefresh = process.env.SLACK_BOOTSTRAP_REFRESH;
  if (bootAccess) {
    const probe = await slack("apps.manifest.export", bootAccess, { app_id: APP_ID });
    if (probe.ok) {
      saveStore({ token: bootAccess, refresh_token: bootRefresh, exp: now + 8 * 3600 });
      return bootAccess;
    }
  }
  if (bootRefresh) return rotate(bootRefresh);
  throw new Error(`no usable tokens (store ${STORE} empty, no bootstrap env)`);
}

async function exportManifest() {
  const r = await slack("apps.manifest.export", await freshToken(), { app_id: APP_ID });
  if (!r.ok) throw new Error(`export failed: ${r.error}`);
  return r.manifest;
}

async function updateManifest(manifest) {
  const r = await slack("apps.manifest.update", await freshToken(), {
    app_id: APP_ID,
    manifest: JSON.stringify(manifest),
  });
  if (!r.ok) throw new Error(`update failed: ${r.error} ${JSON.stringify(r.errors || [])}`);
  return r;
}

function summarize(m) {
  const home = m.features?.app_home || {};
  const ev = m.settings?.event_subscriptions || {};
  console.log("bot_user:", m.features?.bot_user?.display_name || "(none)");
  console.log("app_home.home_tab_enabled:", home.home_tab_enabled);
  console.log("app_home.messages_tab_enabled:", home.messages_tab_enabled);
  console.log("app_home.messages_tab_read_only_enabled:", home.messages_tab_read_only_enabled);
  console.log("bot scopes:", (m.oauth_config?.scopes?.bot || []).join(", "));
  console.log("event request_url:", ev.request_url || "(none)");
  console.log("bot_events:", (ev.bot_events || []).join(", ") || "(none)");
  console.log("interactivity:", m.settings?.interactivity?.is_enabled ?? false);
}

const cmd = process.argv[2] || "status";
try {
  if (cmd === "status") {
    summarize(await exportManifest());
  } else if (cmd === "dump") {
    console.log(JSON.stringify(await exportManifest(), null, 2));
  } else if (cmd === "enable-messages") {
    const m = await exportManifest();
    m.features = m.features || {};
    m.features.app_home = m.features.app_home || {};
    const before = JSON.stringify(m.features.app_home);
    m.features.app_home.messages_tab_enabled = true;
    m.features.app_home.messages_tab_read_only_enabled = false;
    await updateManifest(m);
    console.log("app_home before:", before);
    console.log("--- after update ---");
    summarize(await exportManifest());
  } else if (cmd === "provision") {
    // Bring the app config in line with what the code already intends: enable
    // the Messages tab (so users can DM the bot) and ensure the bot scopes the
    // code requests (DEFAULT_SLACK_SCOPES + im:history for message.im events).
    // Purely additive to existing scopes — never removes what's already granted.
    const WANT_SCOPES = [
      "chat:write",
      "chat:write.public",
      "channels:read",
      "groups:read",
      "im:write",
      "im:history",
    ];
    const m = await exportManifest();
    m.features = m.features || {};
    m.features.app_home = m.features.app_home || {};
    m.features.app_home.messages_tab_enabled = true;
    m.features.app_home.messages_tab_read_only_enabled = false;
    m.oauth_config = m.oauth_config || {};
    m.oauth_config.scopes = m.oauth_config.scopes || {};
    const current = m.oauth_config.scopes.bot || [];
    const merged = Array.from(new Set([...current, ...WANT_SCOPES]));
    const added = merged.filter((s) => !current.includes(s));
    m.oauth_config.scopes.bot = merged;
    await updateManifest(m);
    console.log("scopes added:", added.length ? added.join(", ") : "(none — already present)");
    console.log("--- after update ---");
    summarize(await exportManifest());
  } else {
    console.log("usage: node slack-manifest.mjs [status|dump|enable-messages|provision]");
  }
} catch (err) {
  console.error("ERROR:", err.message);
  process.exit(1);
}
