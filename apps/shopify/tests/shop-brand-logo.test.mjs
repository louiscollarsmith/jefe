import assert from "node:assert/strict";
import test from "node:test";
import {
  brandLogoFromPayload,
  pickBrandLogoUrl,
  ensureShopBrandLogo,
} from "../app/lib/shop/brand-logo.server.js";

test("pickBrandLogoUrl prefers squareLogo, falls back to logo, else null", () => {
  assert.equal(
    pickBrandLogoUrl({
      squareLogo: { image: { url: "https://cdn/sq.png" } },
      logo: { image: { url: "https://cdn/wide.png" } },
    }),
    "https://cdn/sq.png",
  );
  assert.equal(
    pickBrandLogoUrl({ squareLogo: null, logo: { image: { url: "https://cdn/wide.png" } } }),
    "https://cdn/wide.png",
  );
  // an unprocessed image (null) or empty url is not a real asset
  assert.equal(pickBrandLogoUrl({ squareLogo: { image: null }, logo: { image: { url: "" } } }), null);
  assert.equal(pickBrandLogoUrl(null), null);
  assert.equal(pickBrandLogoUrl({}), null);
});

test("brandLogoFromPayload reads rawPayload.shopify.brandLogoUrl, else null", () => {
  assert.equal(
    brandLogoFromPayload({ shopify: { brandLogoUrl: "https://cdn/x.png" } }),
    "https://cdn/x.png",
  );
  assert.equal(brandLogoFromPayload({ shopify: { brandLogoUrl: "   " } }), null);
  assert.equal(brandLogoFromPayload({ shopify: {} }), null);
  assert.equal(brandLogoFromPayload({}), null);
  assert.equal(brandLogoFromPayload(null), null);
});

test("ensureShopBrandLogo: cached → no fetch; missing → fetch+persist; no-logo/error → graceful", async () => {
  // already cached → returns without touching the client or persisting
  {
    let requested = false;
    const prisma = {
      shop: {
        findUnique: async () => ({
          rawPayload: { shopify: { brandLogoUrl: "https://cdn/cached.png" } },
        }),
        update: async () => {
          throw new Error("should not persist when already cached");
        },
      },
    };
    const client = {
      request: async () => {
        requested = true;
        return {};
      },
    };
    const res = await ensureShopBrandLogo(prisma, { shopId: "s1", client });
    assert.equal(res.status, "already_set");
    assert.equal(requested, false);
  }

  // not cached → fetch, pick squareLogo, persist WITHOUT clobbering existing payload
  {
    let persisted = null;
    const prisma = {
      shop: {
        findUnique: async () => ({ rawPayload: { shopify: { name: "Acme" } } }),
        update: async ({ data }) => {
          persisted = data.rawPayload;
          return {};
        },
      },
    };
    const client = {
      request: async () => ({
        shop: { brand: { squareLogo: { image: { url: "https://cdn/sq.png" } } } },
      }),
    };
    const res = await ensureShopBrandLogo(prisma, { shopId: "s1", client });
    assert.equal(res.status, "persisted");
    assert.equal(res.hasLogo, true);
    assert.equal(persisted.shopify.brandLogoUrl, "https://cdn/sq.png");
    assert.equal(persisted.shopify.name, "Acme"); // existing payload preserved
  }

  // brand present but no usable logo → no persist, hasLogo false
  {
    const prisma = {
      shop: {
        findUnique: async () => ({ rawPayload: {} }),
        update: async () => {
          throw new Error("should not persist when there is no logo");
        },
      },
    };
    const client = { request: async () => ({ shop: { brand: null } }) };
    const res = await ensureShopBrandLogo(prisma, { shopId: "s1", client });
    assert.equal(res.status, "no_logo");
    assert.equal(res.hasLogo, false);
  }

  // client throws (e.g. field not accessible under scopes) → best-effort, never throws
  {
    const prisma = {
      shop: { findUnique: async () => ({ rawPayload: {} }), update: async () => {} },
    };
    const client = {
      request: async () => {
        throw new Error("scope denied");
      },
    };
    const res = await ensureShopBrandLogo(prisma, { shopId: "s1", client });
    assert.equal(res.status, "error");
    assert.equal(res.hasLogo, false);
  }
});
