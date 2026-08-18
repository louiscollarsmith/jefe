import assert from "node:assert/strict";
import test from "node:test";
import {
  brandLogoFromPayload,
  hasFreshBrandLogoCheck,
  pickBrandLogoUrl,
  ensureShopBrandLogo,
  SHOP_BRAND_QUERY,
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
  // javascript: and http: must not become <img src>
  assert.equal(
    pickBrandLogoUrl({ logo: { image: { url: "javascript:alert(1)" } } }),
    null,
  );
  assert.equal(
    pickBrandLogoUrl({ logo: { image: { url: "http://cdn/insecure.png" } } }),
    null,
  );
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

test("hasFreshBrandLogoCheck is true for a cached URL or a recent miss", () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  assert.equal(
    hasFreshBrandLogoCheck({ shopify: { brandLogoUrl: "https://cdn/x.png" } }, now),
    true,
  );
  assert.equal(
    hasFreshBrandLogoCheck(
      { shopify: { brandLogoCheckedAt: "2026-08-18T11:00:00.000Z" } },
      now,
    ),
    true,
  );
  assert.equal(
    hasFreshBrandLogoCheck(
      { shopify: { brandLogoCheckedAt: "2026-08-16T12:00:00.000Z" } },
      now,
    ),
    false,
  );
  assert.equal(hasFreshBrandLogoCheck({ shopify: {} }, now), false);
});

function memoryShop(rawPayload) {
  let payload = rawPayload;
  return {
    payload: () => payload,
    prisma: {
      shop: {
        findUnique: async () => ({ rawPayload: payload }),
        update: async ({ data }) => {
          payload = data.rawPayload;
          return {};
        },
      },
    },
  };
}

test("ensureShopBrandLogo: cached → no fetch; missing → fetch+persist; miss/error → remember", async () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");

  // already cached → returns without touching the client or persisting
  {
    let requested = false;
    const shop = memoryShop({ shopify: { brandLogoUrl: "https://cdn/cached.png" } });
    const client = {
      request: async () => {
        requested = true;
        return {};
      },
    };
    const res = await ensureShopBrandLogo(shop.prisma, {
      shopId: "s1",
      client,
      now,
    });
    assert.equal(res.status, "already_set");
    assert.equal(requested, false);
  }

  // not cached → fetch, pick squareLogo, persist WITHOUT clobbering existing payload
  {
    const shop = memoryShop({ shopify: { name: "Acme" } });
    const client = {
      request: async () => ({
        shop: { brand: { squareLogo: { image: { url: "https://cdn/sq.png" } } } },
      }),
    };
    const res = await ensureShopBrandLogo(shop.prisma, { shopId: "s1", client, now });
    assert.equal(res.status, "persisted");
    assert.equal(res.hasLogo, true);
    assert.equal(shop.payload().shopify.brandLogoUrl, "https://cdn/sq.png");
    assert.equal(shop.payload().shopify.name, "Acme"); // existing payload preserved
    assert.equal(shop.payload().shopify.brandLogoCheckedAt, "2026-08-18T12:00:00.000Z");
  }

  // brand present but no usable logo → persist a check so the next load stays quiet
  {
    const shop = memoryShop({});
    const client = { request: async () => ({ shop: { brand: null } }) };
    const res = await ensureShopBrandLogo(shop.prisma, { shopId: "s1", client, now });
    assert.equal(res.status, "no_logo");
    assert.equal(res.hasLogo, false);
    assert.equal(shop.payload().shopify.brandLogoCheckedAt, "2026-08-18T12:00:00.000Z");
    assert.equal(shop.payload().shopify.brandLogoUrl, undefined);
  }

  // client throws → best-effort, never throws, and the miss is remembered
  {
    const shop = memoryShop({});
    const client = {
      request: async () => {
        throw new Error("scope denied");
      },
    };
    const res = await ensureShopBrandLogo(shop.prisma, { shopId: "s1", client, now });
    assert.equal(res.status, "error");
    assert.equal(res.hasLogo, false);
    assert.equal(shop.payload().shopify.brandLogoCheckedAt, "2026-08-18T12:00:00.000Z");
  }

  // a fresh miss is not fetched again
  {
    let requested = false;
    const shop = memoryShop({
      shopify: { brandLogoCheckedAt: "2026-08-18T11:30:00.000Z" },
    });
    const client = {
      request: async () => {
        requested = true;
        return {};
      },
    };
    const res = await ensureShopBrandLogo(shop.prisma, { shopId: "s1", client, now });
    assert.equal(res.status, "recently_checked");
    assert.equal(requested, false);
  }
});

test("ensureShopBrandLogo reads shop.brand from the tokenless Storefront API, not Admin", async () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  const shop = memoryShop({ shopify: { name: "Acme" } });
  /** @type {{ url?: string, headers?: HeadersInit }} */
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = String(url);
    seen.headers = init?.headers;
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.query, SHOP_BRAND_QUERY);
    return new Response(
      JSON.stringify({
        data: {
          shop: {
            brand: { logo: { image: { url: "https://cdn.shopify.com/logo.png" } } },
          },
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const res = await ensureShopBrandLogo(shop.prisma, {
    shopId: "s1",
    shopDomain: "acme.myshopify.com",
    accessToken: "shpat_should_not_be_sent",
    fetchImpl,
    now,
  });

  assert.equal(res.status, "persisted");
  assert.equal(res.hasLogo, true);
  assert.equal(seen.url, "https://acme.myshopify.com/api/2026-07/graphql.json");
  assert.equal(String(seen.url).includes("/admin/"), false);
  const headers = new Headers(seen.headers);
  assert.equal(headers.get("X-Shopify-Access-Token"), null);
  assert.equal(headers.get("X-Shopify-Storefront-Access-Token"), null);
  assert.equal(shop.payload().shopify.brandLogoUrl, "https://cdn.shopify.com/logo.png");
});

test("ensureShopBrandLogo does not retry a Storefront GraphQL miss on the next load", async () => {
  const now = Date.parse("2026-08-18T12:00:00.000Z");
  const shop = memoryShop({});
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return new Response(
      JSON.stringify({
        errors: [
          {
            message: "Field 'brand' doesn't exist on type 'Shop'",
            extensions: { code: "undefinedField", typeName: "Shop", fieldName: "brand" },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const first = await ensureShopBrandLogo(shop.prisma, {
    shopId: "s1",
    shopDomain: "acme.myshopify.com",
    fetchImpl,
    now,
  });
  assert.equal(first.status, "unsupported");
  assert.equal(fetches, 1);

  const second = await ensureShopBrandLogo(shop.prisma, {
    shopId: "s1",
    shopDomain: "acme.myshopify.com",
    fetchImpl,
    now: now + 60_000,
  });
  assert.equal(second.status, "recently_checked");
  assert.equal(fetches, 1);
});
