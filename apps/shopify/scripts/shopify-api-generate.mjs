import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadShopifyApiCatalog } from "../app/lib/shopify/api/catalog.server.js";
import {
  buildShopifyApiCatalogFromIntrospection,
  renderShopifyApiGenerationReport,
} from "../app/lib/shopify/api/generation.server.js";
import { ShopifyAdminGraphqlClient } from "../app/lib/shopify/admin-graphql.server.js";

const args = parseArgs(process.argv.slice(2));
const apiVersion = args.apiVersion || process.env.SHOPIFY_API_VERSION || "2026-07";
const outputPath = resolve(
  args.output || `app/lib/shopify/api/catalogs/shopify-admin-api-${apiVersion}.generated.json`,
);
const reportPath = resolve(args.report || `docs/ops/shopify-admin-api-${apiVersion}-generation.md`);

const previous = safeLoadCatalog(outputPath);
let next = previous;
if (args.introspection) {
  const introspection = JSON.parse(readFileSync(resolve(args.introspection), "utf8"));
  next = buildShopifyApiCatalogFromIntrospection(introspection, { apiVersion });
} else if (args.shop && args.tokenEnv) {
  const accessToken = process.env[args.tokenEnv];
  if (!accessToken) throw new Error(`Token env ${args.tokenEnv} is not set.`);
  const client = new ShopifyAdminGraphqlClient({
    shopDomain: args.shop,
    accessToken,
    apiVersion,
    logger: { info() {}, warn() {}, error() {} },
  });
  const introspection = await client.request(INTROSPECTION_QUERY, {});
  next = buildShopifyApiCatalogFromIntrospection(introspection, { apiVersion });
} else if (!next) {
  throw new Error(
    "No existing generated catalog found. Pass --introspection=path/to/schema.json or --shop=<dev.myshopify.com> --token-env=ENV_NAME.",
  );
}

mkdirSync(dirname(outputPath), { recursive: true });
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(next, null, 2)}\n`);
writeFileSync(reportPath, renderShopifyApiGenerationReport(previous, next));

process.stdout.write(
  [
    `catalog=${outputPath}`,
    `report=${reportPath}`,
    `apiVersion=${next.apiVersion}`,
    `operations=${next.operations.length}`,
  ].join("\n") + "\n",
);

function safeLoadCatalog(path) {
  try {
    return loadShopifyApiCatalog({ catalogPath: path });
  } catch {
    return null;
  }
}

function parseArgs(values) {
  const parsed = {};
  for (const value of values) {
    const match = value.match(/^--([^=]+)=(.*)$/);
    if (match) parsed[toCamel(match[1])] = match[2];
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

const TYPE_REF = `
fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType { kind name }
      }
    }
  }
}`;

const INTROSPECTION_QUERY = `
${TYPE_REF}
query JefeAdminApiIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind
      name
      description
      enumValues(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
      }
      inputFields {
        name
        description
        type { ...TypeRef }
        defaultValue
      }
      fields(includeDeprecated: true) {
        name
        description
        isDeprecated
        deprecationReason
        args {
          name
          description
          type { ...TypeRef }
          defaultValue
        }
        type { ...TypeRef }
      }
    }
  }
}`;
