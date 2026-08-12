import crypto from "node:crypto";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const testEnv = {
  ...process.env,
  NODE_ENV: "test",
  JEFE_EXTERNAL_LLM_DISABLED: "true",
  LLM_ENABLED: "false",
  EPISODIC_EMBEDDING_ENABLED: "false",
  ENABLE_SHOPIFY_BACKFILL_LOOP: "false",
};

if (testEnv.TEST_DATABASE_URL) {
  assertTestDatabaseUrl(testEnv.TEST_DATABASE_URL);
  testEnv.DATABASE_URL = testEnv.TEST_DATABASE_URL;
  process.stdout.write("# isolated test database: TEST_DATABASE_URL\n");
  run("npx", ["prisma", "migrate", "deploy"], testEnv);
} else if (testEnv.DATABASE_URL && isLocalDatabaseUrl(testEnv.DATABASE_URL)) {
  const workspaceFingerprint = crypto
    .createHash("sha256")
    .update(process.cwd())
    .digest("hex")
    .slice(0, 12);
  const databaseName = `jefe_test_${workspaceFingerprint}`;
  testEnv.DATABASE_URL = await ensureTestDatabase(
    testEnv.DATABASE_URL,
    databaseName,
  );
  process.stdout.write(`# isolated test database: ${databaseName}\n`);
  run("npx", ["prisma", "migrate", "deploy"], testEnv);
} else if (testEnv.DATABASE_URL) {
  delete testEnv.DATABASE_URL;
  process.stdout.write(
    "# DB-gated tests disabled: refusing to use a remote DATABASE_URL without an explicitly test-named TEST_DATABASE_URL\n",
  );
}

const availableTestFiles = readdirSync(new URL("../tests/", import.meta.url))
  .filter((file) => file.endsWith(".test.mjs"))
  .sort();
const requestedTestFiles = process.argv.slice(2).map((value) =>
  value.startsWith("tests/") ? value.slice("tests/".length) : value,
);
const testFiles = requestedTestFiles.length
  ? requestedTestFiles
  : availableTestFiles;

for (const file of testFiles) {
  if (!availableTestFiles.includes(file)) {
    throw new Error(`Unknown test file: ${file}`);
  }
  process.stdout.write(`# tests/${file}\n`);
  run(process.execPath, ["--test", `tests/${file}`], testEnv);
}

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function ensureTestDatabase(baseUrl, databaseName) {
  if (!/^jefe_test_[a-f0-9]{12}$/.test(databaseName)) {
    throw new Error("Refusing to create an invalid test database name.");
  }
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  adminUrl.searchParams.set("schema", "public");
  const admin = new PrismaClient({
    datasources: { db: { url: adminUrl.toString() } },
  });
  try {
    const existing = await admin.$queryRawUnsafe(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      databaseName,
    );
    if (!existing.length) {
      try {
        await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
      } catch (error) {
        const raced = await admin.$queryRawUnsafe(
          "SELECT 1 FROM pg_database WHERE datname = $1",
          databaseName,
        );
        if (!raced.length) throw error;
      }
    }
  } finally {
    await admin.$disconnect();
  }

  const testUrl = new URL(baseUrl);
  testUrl.pathname = `/${databaseName}`;
  testUrl.searchParams.set("schema", "public");
  return testUrl.toString();
}

function isLocalDatabaseUrl(value) {
  const hostname = new URL(value).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function assertTestDatabaseUrl(value) {
  const url = new URL(value);
  const databaseName = url.pathname.slice(1).toLowerCase();
  const schema = (url.searchParams.get("schema") ?? "").toLowerCase();
  if (!databaseName.includes("test") && !schema.includes("test")) {
    throw new Error(
      "TEST_DATABASE_URL must name a test database or test schema; refusing a production-shaped target.",
    );
  }
}
