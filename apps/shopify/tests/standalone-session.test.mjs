import assert from "node:assert/strict";
import test from "node:test";

// The session module reads SESSION_SECRET lazily (per call), so setting it here
// — after the hoisted import — is fine.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "test-session-secret-abc123";

import {
  serializeStandaloneSession,
  readStandaloneSession,
  sessionNeedsRefresh,
  destroyStandaloneSession,
  SESSION_TTL_SECONDS,
} from "../app/lib/auth/standalone-session.server.js";

/** Turn a `Set-Cookie` string into a stand-in request carrying that cookie. */
function reqWithCookie(setCookie) {
  const headers = new Headers();
  if (setCookie) headers.set("Cookie", setCookie.split(";")[0]);
  return { headers };
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

test("round-trips a signed session and normalizes the shop", async () => {
  const setCookie = await serializeStandaloneSession("Store-1.MyShopify.com");
  assert.match(setCookie, /^jefe_standalone_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//);

  const session = await readStandaloneSession(reqWithCookie(setCookie));
  assert.ok(session, "expected a session");
  assert.equal(session.shop, "store-1.myshopify.com");
  assert.ok(session.exp > session.iat);
  assert.equal(session.exp - session.iat, SESSION_TTL_SECONDS);
});

test("refuses to issue a session for a non-myshopify shop", async () => {
  await assert.rejects(() => serializeStandaloneSession("evil.com"));
  await assert.rejects(() => serializeStandaloneSession("store.myshopify.com.evil.com"));
  await assert.rejects(() => serializeStandaloneSession(""));
});

test("returns null when there is no cookie", async () => {
  assert.equal(await readStandaloneSession(reqWithCookie(null)), null);
});

test("returns null for a tampered cookie (bad signature)", async () => {
  const setCookie = await serializeStandaloneSession("store.myshopify.com");
  const nameValue = setCookie.split(";")[0];
  // Flip a character in the signature region.
  const i = nameValue.length - 5;
  const flipped = nameValue.slice(0, i) + (nameValue[i] === "A" ? "B" : "A") + nameValue.slice(i + 1);
  assert.notEqual(flipped, nameValue);
  const headers = new Headers();
  headers.set("Cookie", flipped);
  assert.equal(await readStandaloneSession({ headers }), null);
});

test("returns null for an expired session (server-side exp gate)", async () => {
  // iat far in the past -> exp = iat + TTL is still long before now.
  const expired = await serializeStandaloneSession("store.myshopify.com", { nowSeconds: 1000 });
  assert.equal(await readStandaloneSession(reqWithCookie(expired)), null);

  // A live cookie read at a clock past its expiry is also rejected.
  const live = await serializeStandaloneSession("store.myshopify.com");
  assert.equal(
    await readStandaloneSession(reqWithCookie(live), {
      nowSeconds: nowSec() + SESSION_TTL_SECONDS + 10,
    }),
    null,
  );
});

test("sessionNeedsRefresh flips at the half-life", () => {
  const session = { shop: "s.myshopify.com", iat: 1000, exp: 1000 + SESSION_TTL_SECONDS };
  const half = SESSION_TTL_SECONDS / 2;
  assert.equal(sessionNeedsRefresh(session, { nowSeconds: 1000 }), false);
  assert.equal(sessionNeedsRefresh(session, { nowSeconds: 1000 + half - 1 }), false);
  assert.equal(sessionNeedsRefresh(session, { nowSeconds: 1000 + half }), true);
  assert.equal(sessionNeedsRefresh(null), false);
});

test("destroyStandaloneSession clears the cookie", async () => {
  const cleared = await destroyStandaloneSession();
  assert.match(cleared, /^jefe_standalone_session=/);
  assert.match(cleared, /Max-Age=0/);
});

test("Secure is set in production, absent in development", async () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const prod = await serializeStandaloneSession("store.myshopify.com");
    assert.match(prod, /Secure/);
  } finally {
    process.env.NODE_ENV = previous;
  }
  const dev = await serializeStandaloneSession("store.myshopify.com");
  assert.doesNotMatch(dev, /Secure/);
});
