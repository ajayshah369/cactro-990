CREATE TYPE "NotificationType" AS ENUM ('BOOKING_CONFIRMATION', 'EVENT_UPDATED');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "notification_jobs" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "eventId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "bookingId" TEXT,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMPTZ(3),
    "lockToken" TEXT,
    "processedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_jobs_bookingId_key" ON "notification_jobs"("bookingId");
CREATE INDEX "notification_jobs_status_availableAt_createdAt_id_idx" ON "notification_jobs"("status", "availableAt", "createdAt", "id");
CREATE INDEX "notification_jobs_status_lockedAt_idx" ON "notification_jobs"("status", "lockedAt");
CREATE INDEX "notification_jobs_eventId_idx" ON "notification_jobs"("eventId");
CREATE INDEX "notification_jobs_customerId_idx" ON "notification_jobs"("customerId");

ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notification_jobs" ADD CONSTRAINT "notification_jobs_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
