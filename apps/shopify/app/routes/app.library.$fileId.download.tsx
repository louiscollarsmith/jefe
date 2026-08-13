import type { LoaderFunctionArgs } from "react-router";

import { authenticateAppRequest } from "../lib/auth/authenticate-app-request.server.js";
import { getMerchantFileBytes } from "../lib/attachments/merchant-file.server.js";
import { ensureShopifyTenant } from "../lib/ingestion/shopify/tenant.server";
import { splitScopes } from "../services/shopify-backfill-status.server";
import prisma from "../db.server";

// Giving a merchant their own file back. The ONLY path in the app that reads `content`.
//
// ⚠️ Ownership is resolved from the SESSION, never from the URL. The file id is merchant-supplied
// and guessable in principle; `getMerchantFileBytes` puts merchantId in the where clause, so a
// valid id belonging to someone else returns nothing rather than someone else's invoice.
//
// A 404 for "not yours" and "not there" alike, deliberately: distinguishing them would confirm
// that a given id exists on another store.

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticateAppRequest(request);
  const { merchant } = await ensureShopifyTenant(prisma, {
    shopDomain: session.shop,
    accessTokenSessionId: session.id,
    scopes: splitScopes(session.scope),
    rawPayload: { source: "jefe_library_download" },
  });

  const file = await getMerchantFileBytes(prisma, {
    merchantId: merchant.id,
    fileId: String(params.fileId ?? ""),
  });
  if (!file) throw new Response("Not found", { status: 404 });

  return new Response(Buffer.from(file.content), {
    headers: {
      "Content-Type": file.mimeType || "application/octet-stream",
      // `attachment` rather than `inline`: a merchant-supplied file rendered in the browser on
      // our origin is a stored-XSS primitive (an SVG or HTML file carries script). Downloading
      // it is what they asked for anyway.
      "Content-Disposition": `attachment; filename="${asciiFilename(file.filename)}"`,
      "Content-Length": String(file.byteSize),
      // Their own file, but still: never cached by anything shared.
      "Cache-Control": "private, no-store",
    },
  });
};

/**
 * A filename in a header must survive the header. Quotes and non-ASCII would break the
 * Content-Disposition parse, so this keeps a boring ASCII fallback rather than gambling.
 */
function asciiFilename(value: string): string {
  const cleaned = String(value ?? "")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim();
  return cleaned.slice(0, 100) || "file";
}
