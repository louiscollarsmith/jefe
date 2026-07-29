import assert from "node:assert/strict";
import test from "node:test";

import {
  requestHost,
  isStandaloneHost,
  resolveAuthMode,
} from "../app/lib/auth/auth-mode.server.js";

/** Minimal request stand-in: the module only reads `.url` + `.headers.get`. */
function req(url, headers = {}) {
  return { url, headers: new Headers(headers) };
}

const liveSession = { shop: "store.myshopify.com", iat: 1, exp: 9_999_999_999 };

test("requestHost prefers X-Forwarded-Host, strips port, lower-cases", () => {
  assert.equal(
    requestHost(req("https://internal.local/app", { "X-Forwarded-Host": "app.mynamejefe.com" })),
    "app.mynamejefe.com",
  );
  // No forwarded/Host header -> falls back to the URL host.
  assert.equal(requestHost(req("https://app.mynamejefe.com:8080/app")), "app.mynamejefe.com");
  // First of a comma list, lower-cased.
  assert.equal(
    requestHost(req("https://x/app", { "X-Forwarded-Host": "App.MyNameJefe.com, proxy" })),
    "app.mynamejefe.com",
  );
});

test("isStandaloneHost matches only the standalone host", () => {
  assert.equal(isStandaloneHost(req("https://x/app", { "X-Forwarded-Host": "app.mynamejefe.com" })), true);
  assert.equal(isStandaloneHost(req("https://jefe-production.up.railway.app/app")), false);
});

test("resolveAuthMode: non-standalone host is always embedded", async () => {
  // Embedded host, even with a standalone cookie injected, resolves embedded —
  // host is the primary discriminator.
  assert.equal(
    await resolveAuthMode(req("https://jefe-production.up.railway.app/app"), { session: liveSession }),
    "embedded",
  );
  assert.equal(
    await resolveAuthMode(req("https://jefe-production.up.railway.app/app"), { session: null }),
    "embedded",
  );
});

test("resolveAuthMode: standalone host + valid cookie -> standalone", async () => {
  assert.equal(
    await resolveAuthMode(req("https://x/app", { "X-Forwarded-Host": "app.mynamejefe.com" }), {
      session: liveSession,
    }),
    "standalone",
  );
});

test("resolveAuthMode: standalone host + no cookie -> standalone-login", async () => {
  assert.equal(
    await resolveAuthMode(req("https://x/app", { "X-Forwarded-Host": "app.mynamejefe.com" }), {
      session: null,
    }),
    "standalone-login",
  );
});
