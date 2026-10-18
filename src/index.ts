import { writeSync } from "node:fs";
import type { Server } from "node:http";
import { app } from "./server.js";
import { prisma } from "./database/database.js";
import { env } from "./config/env.js";

let server: Server | undefined;
let shuttingDown = false;
let shutdownExitCode = 0;

// Fatal errors: log synchronously, then terminate.
function fatalError(event: string, error: unknown): never {
  try {
    const details =
      error instanceof Error ? (error.stack ?? error.message) : String(error);

    writeSync(2, `[${event}] ${details}\n`);
  } finally {
    process.exit(1);
  }
}

async function initialize(): Promise<void> {
  await prisma.$connect();
  await prisma.$queryRaw`SELECT 1`;

  // A shutdown signal might arrive while connecting.
  if (shuttingDown) return;

  console.log("PostgreSQL connected successfully");

  await new Promise<void>((resolve, reject) => {
    server = app.listen(env.PORT, "127.0.0.1", (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  if (!shuttingDown) {
    console.log(`Server listening on http://localhost:${env.PORT}`);
  }
}

async function shutdown(reason: string, exitCode = 0): Promise<void> {
  // Preserve a failure code if shutdown is already underway.
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);

  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Shutting down: ${reason}`);

  const timeout = setTimeout(() => {
    fatalError("Shutdown timeout", "Cleanup exceeded 10 seconds");
  }, 10_000);

  try {
    // Let initialization settle before cleaning up its resources.
    await startup.catch(() => undefined);

    const activeServer = server;

    if (activeServer?.listening) {
      await new Promise<void>((resolve, reject) => {
        activeServer.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }

    // Active HTTP requests have finished using the database.
    await prisma.$disconnect();

    console.log("Shutdown complete");

    clearTimeout(timeout);
    process.exitCode = shutdownExitCode;
  } catch (error) {
    fatalError("Shutdown failed", error);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("unhandledRejection", (reason: unknown) => {
  fatalError("Unhandled promise rejection", reason);
});

process.on("uncaughtException", (error: Error) => {
  fatalError("Uncaught exception", error);
});

const startup = initialize();

void startup.catch((error: unknown) => {
  console.error("Application startup failed:", error);
  void shutdown("Startup failure", 1);
});
