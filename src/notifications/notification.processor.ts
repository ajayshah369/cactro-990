import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { prisma } from "../database/database.js";
import { Prisma, type NotificationJob } from "../generated/prisma/client.js";
import { logNotification, notificationMessageSchema, type NotificationSender } from "./notification.sender.js";

async function claimNotification(eventId?: string) {
  return prisma.$transaction(async (tx) => {
    const [job] = await tx.$queryRaw<NotificationJob[]>`
      SELECT * FROM "notification_jobs"
      WHERE (
        ("status" = 'PENDING' AND "availableAt" <= CURRENT_TIMESTAMP)
        OR ("status" = 'PROCESSING' AND "lockedAt" <= CURRENT_TIMESTAMP - ${env.NOTIFICATION_LEASE_MS} * INTERVAL '1 millisecond')
      )
      ${eventId ? Prisma.sql`AND "eventId" = ${eventId}` : Prisma.empty}
      ORDER BY "availableAt", "createdAt", "id"
      LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!job) return null;

    // A crash on the final attempt must not leave the job PROCESSING forever.
    if (job.attempts >= env.NOTIFICATION_MAX_ATTEMPTS) {
      return tx.notificationJob.update({
        where: { id: job.id },
        data: { status: "FAILED", lockedAt: null, lockToken: null, lastError: "Worker lease expired after the final attempt" },
      });
    }
    return tx.notificationJob.update({
      where: { id: job.id },
      data: { status: "PROCESSING", attempts: { increment: 1 }, lockedAt: new Date(), lockToken: randomUUID() },
    });
  });
}

// eventId allows isolated integration tests to process only their own fixtures.
export async function processNextNotification(options: { send?: NotificationSender; eventId?: string } = {}): Promise<boolean> {
  const job = await claimNotification(options.eventId);
  if (!job) return false;
  if (job.status === "FAILED") {
    console.error("[notification:failed]", { jobId: job.id, attempts: job.attempts, error: job.lastError });
    return true;
  }

  // Match the claim token so a worker whose lease expired cannot overwrite a newer claim.
  const claim = { id: job.id, status: "PROCESSING" as const, lockToken: job.lockToken };
  try {
    const payload = notificationMessageSchema.parse(job.payload);
    // Delivery occurs after the short claim transaction commits, with no DB lock held.
    await (options.send ?? logNotification)({ ...payload, jobId: job.id, type: job.type });
    await prisma.notificationJob.updateMany({
      where: claim,
      data: { status: "COMPLETED", processedAt: new Date(), lockedAt: null, lockToken: null, lastError: null },
    });
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
    const exhausted = job.attempts >= env.NOTIFICATION_MAX_ATTEMPTS;
    const delay = Math.min(env.NOTIFICATION_RETRY_DELAY_MS * 2 ** (job.attempts - 1), 60_000);
    await prisma.notificationJob.updateMany({
      where: claim,
      data: {
        status: exhausted ? "FAILED" : "PENDING", lastError: message,
        availableAt: new Date(Date.now() + delay), lockedAt: null, lockToken: null,
      },
    });
    console.error(exhausted ? "[notification:failed]" : "[notification:retry]", { jobId: job.id, attempts: job.attempts, error: message });
  }
  return true;
}
