import { setTimeout as sleep } from "node:timers/promises";
import { env } from "../config/env.js";
import { processNextNotification } from "./notification.processor.js";

export async function runNotificationWorker(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      if (await processNextNotification()) continue;
    } catch (error) {
      // A database outage should pause processing, not abandon already queued jobs.
      console.error("[notification:worker-error]", error);
    }

    try {
      await sleep(env.NOTIFICATION_POLL_INTERVAL_MS, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
