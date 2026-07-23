import { spawn } from "node:child_process";
import { loadLocalEnv } from "./load-env.mjs";

loadLocalEnv();

const children = new Set();
let shuttingDown = false;

const web = start("web", "shopify", ["app", "dev"], {
  ...process.env,
  ENABLE_SHOPIFY_BACKFILL_LOOP: "false",
});
const worker = start("worker", process.execPath, [
  "scripts/shopify-backfill-worker.mjs",
]);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal, 0));
}

function start(label, command, args, env = process.env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["inherit", "pipe", "pipe"],
  });
  children.add(child);

  child.stdout.on("data", (chunk) => {
    process.stdout.write(prefixLines(label, chunk));
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(prefixLines(label, chunk));
  });
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (shuttingDown) return;
    const status = signal ? `${signal}` : `${code ?? 0}`;
    console.error(`${label} process exited (${status}); stopping dev stack.`);
    shutdown(`${label}_exit`, code ?? 1);
  });

  return child;
}

function shutdown(reason, exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Stopping Shopify dev stack after ${reason}.`);
  for (const child of children) {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    process.exit(exitCode);
  }, 5_000).unref();
}

function prefixLines(label, chunk) {
  return String(chunk)
    .split(/(\r?\n)/)
    .map((part) => {
      if (part === "\n" || part === "\r\n" || part === "") return part;
      return `[${label}] ${part}`;
    })
    .join("");
}

void web;
void worker;
