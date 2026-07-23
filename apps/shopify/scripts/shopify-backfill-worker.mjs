import { PrismaClient } from "@prisma/client";
import { loadLocalEnv } from "./load-env.mjs";
import { processNextBackfillJob } from "../app/services/shopify-backfill-worker.server.js";

loadLocalEnv();

const intervalMs = positiveInteger(
  process.env.SHOPIFY_BACKFILL_WORKER_INTERVAL_MS,
  15_000,
);
const prisma = new PrismaClient();
let stopping = false;
let running = false;
let interval = null;

console.log(`Shopify backfill worker started; polling every ${intervalMs}ms.`);

async function tick() {
  if (running || stopping) return;
  running = true;
  try {
    const result = await processNextBackfillJob(prisma, { logger: console });
    if (result) {
      console.log(
        `Processed ${result.jobType}: ${result.status}${
          result.error ? ` (${result.error})` : ""
        }`,
      );
    }
  } catch (error) {
    console.error("Shopify backfill worker tick failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    running = false;
  }
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Shopify backfill worker stopping after ${signal}.`);
  if (interval) clearInterval(interval);
  while (running) {
    await sleep(100);
  }
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));

void tick();
interval = setInterval(() => {
  void tick();
}, intervalMs);

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
