import { prisma } from "./database/database.js";
import { runNotificationWorker } from "./notifications/notification.worker.js";

const shutdown = new AbortController();
let shutdownTimer: NodeJS.Timeout | undefined;

function stop(signal: string) {
  if (shutdown.signal.aborted) return;
  console.log(`[notification:worker] Stopping after the current job (${signal})`);
  shutdown.abort();
  shutdownTimer = setTimeout(() => {
    console.error("[notification:worker] Shutdown timed out; unfinished claims will expire");
    process.exit(1);
  }, 10_000);
  shutdownTimer.unref();
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

async function main() {
  try {
    await prisma.$connect();
    // Fail early with a clear database error if migrations have not been applied.
    await prisma.notificationJob.findFirst({ select: { id: true } });
    console.log("[notification:worker] Started in console mode. No real emails will be sent.");
    await runNotificationWorker(shutdown.signal);
  } finally {
    await prisma.$disconnect();
    if (shutdownTimer) clearTimeout(shutdownTimer);
  }
}

void main().catch((error: unknown) => {
  console.error("[notification:worker] Failed:", error);
  process.exitCode = 1;
});
