import assert from "node:assert/strict";
import test from "node:test";

process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-seam";

import { authenticateAppRequest } from "../app/lib/auth/authenticate-app-request.server.js";
import { serializeStandaloneSession } from "../app/lib/auth/standalone-session.server.js";

/** Build a request stand-in on a given host, optionally carrying a session cookie. */
function reqWith({ host, cookie } = {}) {
  const headers = new Headers();
  if (host) headers.set("X-Forwarded-Host", host);
  if (cookie) headers.set("Cookie", cookie.split(";")[0]);
  return { url: "https://x/app", headers };
}

/** Injected Shopify auth fns — no shopify.server import, no side effects. */
const deps = {
  authenticateAdmin: async () => ({
    kind: "embedded",
    admin: { embedded: true },
    session: { shop: "embedded.myshopify.com" },
  }),
  unauthenticatedAdmin: async (shop) => ({
    admin: { shop, graphql: () => {} },
    session: { id: `offline_${shop}`, shop },
  }),
};

test("embedded host delegates to authenticate.admin", async () => {
  const result = await authenticateAppRequest(
    reqWith({ host: "jefe-production.up.railway.app" }),
    deps,
  );
  assert.equal(result.kind, "embedded");
});

test("standalone host + valid cookie resolves via unauthenticated.admin(shop)", async () => {
  const setCookie = await serializeStandaloneSession("store.myshopify.com");
  const result = await authenticateAppRequest(
    reqWith({ host: "app.mynamejefe.com", cookie: setCookie }),
    deps,
  );
  assert.equal(result.standalone, true);
  assert.equal(result.session.shop, "store.myshopify.com");
  assert.equal(result.session.id, "offline_store.myshopify.com");
  assert.equal(result.admin.shop, "store.myshopify.com");
});

test("standalone host + no cookie redirects to the sign-in", async () => {
  let thrown;
  try {
    await authenticateAppRequest(reqWith({ host: "app.mynamejefe.com" }), deps);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Response, "expected a thrown redirect Response");
  assert.equal(thrown.status, 302);
  assert.equal(thrown.headers.get("Location"), "/");
});

test("standalone host + tampered cookie redirects (treated as logged out)", async () => {
  const setCookie = await serializeStandaloneSession("store.myshopify.com");
  const nameValue = setCookie.split(";")[0];
  const tampered = nameValue.slice(0, -4) + (nameValue.endsWith("AAAA") ? "BBBB" : "AAAA");
  const headers = new Headers();
  headers.set("X-Forwarded-Host", "app.mynamejefe.com");
  headers.set("Cookie", tampered);
  let thrown;
  try {
    await authenticateAppRequest({ url: "https://x/app", headers }, deps);
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Response);
  assert.equal(thrown.headers.get("Location"), "/");
});

test("standalone host + valid cookie but unresolvable offline session redirects (no 500)", async () => {
  const setCookie = await serializeStandaloneSession("store.myshopify.com");
  const throwingDeps = {
    authenticateAdmin: deps.authenticateAdmin,
    unauthenticatedAdmin: async () => {
      throw new Error("offline session not found (uninstalled?)");
    },
  };
  let thrown;
  try {
    await authenticateAppRequest(
      reqWith({ host: "app.mynamejefe.com", cookie: setCookie }),
      throwingDeps,
    );
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof Response, "expected a redirect, not a thrown error");
  assert.equal(thrown.status, 302);
  assert.equal(thrown.headers.get("Location"), "/");
});
