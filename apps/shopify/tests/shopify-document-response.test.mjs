import assert from "node:assert/strict";
import test from "node:test";
import {
  getShopifyAppBridgeBootstrap,
  getShopifyStandaloneDocumentResponse,
  isEmptyShopifyResponse,
} from "../app/services/shopify-document-response.server.js";

const appBridgeBootstrap =
  '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script><script>shopify.idToken()</script>';

test("detects Shopify App Bridge bootstrap route responses", () => {
  const reactRouterContext = {
    staticHandlerContext: {
      errors: {
        "routes/app": { status: 200, data: appBridgeBootstrap },
      },
    },
  };

  assert.equal(
    getShopifyAppBridgeBootstrap(reactRouterContext),
    appBridgeBootstrap,
  );
});

test("serves Shopify App Bridge bootstrap as a standalone document with no React hydration payload", async () => {
  const response = getShopifyStandaloneDocumentResponse({
    responseStatusCode: 200,
    responseHeaders: new Headers(),
    reactRouterContext: {
      staticHandlerContext: {
        errors: {
          "routes/app": { status: 200, data: appBridgeBootstrap },
        },
      },
    },
  });

  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "text/html;charset=utf-8");

  const html = await response.text();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /shopifycloud\/app-bridge\.js/);
  assert.doesNotMatch(html, /__reactRouterContext/);
  assert.doesNotMatch(html, /server HTML was replaced/);
  assert.doesNotMatch(html, /Handling response/);
});

test("serves empty Shopify 410 auth responses as a standalone document with no React hydration payload", async () => {
  const reactRouterContext = {
    staticHandlerContext: {
      errors: {
        "routes/app": { status: 410, data: undefined },
      },
    },
  };

  assert.equal(isEmptyShopifyResponse(410, reactRouterContext), true);

  const response = getShopifyStandaloneDocumentResponse({
    responseStatusCode: 410,
    responseHeaders: new Headers(),
    reactRouterContext,
  });

  assert.ok(response);
  assert.equal(response.status, 410);

  const html = await response.text();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<body><\/body>/);
  assert.doesNotMatch(html, /__reactRouterContext/);
  assert.doesNotMatch(html, /Handling response/);
});

test("leaves normal authenticated app renders on the React SSR path", () => {
  const response = getShopifyStandaloneDocumentResponse({
    responseStatusCode: 200,
    responseHeaders: new Headers(),
    reactRouterContext: {
      staticHandlerContext: {
        errors: null,
      },
    },
  });

  assert.equal(response, null);
});
