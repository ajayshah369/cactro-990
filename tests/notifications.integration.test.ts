import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { prisma } from "../src/database/database.js";
import { env } from "../src/config/env.js";
import { createBooking } from "../src/services/booking.service.js";
import { cancelEvent, updateEvent } from "../src/services/event.service.js";
import { queueBookingConfirmation } from "../src/notifications/notification.queue.js";
import { processNextNotification } from "../src/notifications/notification.processor.js";
import type { NotificationMessage } from "../src/notifications/notification.sender.js";

test("background notification queue", async (t) => {
  const tag = `notification-test-${randomUUID()}`;
  const emails = ["organizer", "customer", "other", "late"].map((name) => `${name}-${tag}@example.test`);
  t.after(async () => {
    try {
      await prisma.$transaction([
        prisma.booking.deleteMany({ where: { event: { organizer: { email: { in: emails } } } } }),
        // Notification jobs are removed by their event/booking foreign keys.
        prisma.event.deleteMany({ where: { organizer: { email: { in: emails } } } }),
        prisma.user.deleteMany({ where: { email: { in: emails } } }),
      ]);
    } finally {
      await prisma.$disconnect();
    }
  });
  const [organizer, customer, other, late] = await Promise.all(emails.map((email, index) => prisma.user.create({
    data: { name: index === 0 ? "Test organizer" : "Test customer", email, passwordHash: "unused-test-hash", role: index === 0 ? "ORGANIZER" : "CUSTOMER" },
  })));
  assert.ok(organizer && customer && other && late);

  async function eventFixture() {
    return prisma.event.create({ data: {
      organizerId: organizer!.id, title: `${tag} Workshop`, description: "Original description", venue: "Original venue",
      startsAt: new Date(Date.now() + 86_400_000), endsAt: new Date(Date.now() + 90_000_000),
      capacity: 10, remainingTickets: 10, ticketPrice: 5000,
    } });
  }
  const book = (eventId: string, customerId = customer!.id, idempotencyKey = randomUUID()) =>
    createBooking(customerId, { eventId, quantity: 1, idempotencyKey });
  const jobs = (eventId: string) => prisma.notificationJob.findMany({ where: { eventId }, orderBy: { createdAt: "asc" } });
  async function pendingFixture() {
    const event = await eventFixture();
    await book(event.id);
    return { event, job: (await jobs(event.id))[0]! };
  }

  await t.test("a committed booking queues one confirmation and retries do not duplicate it", async () => {
    const event = await eventFixture();
    const key = randomUUID();
    const created = await book(event.id, customer.id, key);
    const replay = await book(event.id, customer.id, key);
    assert.equal(replay.created, false);
    assert.equal(replay.booking.id, created.booking.id);
    const queued = await jobs(event.id);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]!.type, "BOOKING_CONFIRMATION");
    assert.equal(queued[0]!.status, "PENDING");
    assert.equal(queued[0]!.bookingId, created.booking.id);
    assert.equal(queued[0]!.attempts, 0);
    assert.equal((queued[0]!.payload as { to: string }).to, customer.email);
    assert.match((queued[0]!.payload as { text: string }).text, /INR 50.00/);

    await assert.rejects(createBooking(customer.id, { eventId: event.id, quantity: 11, idempotencyKey: randomUUID() }));
    assert.equal((await jobs(event.id)).length, 1);
  });

  await t.test("simultaneous booking retries still queue exactly one confirmation", async () => {
    const event = await eventFixture();
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => book(event.id, customer.id, key)));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal((await jobs(event.id)).length, 1);
  });

  await t.test("uncommitted jobs are invisible and rollback removes both the booking and job", async () => {
    const event = await eventFixture();
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.event.update({ where: { id: event.id }, data: { remainingTickets: { decrement: 1 } } });
      const booking = await tx.booking.create({ data: {
        eventId: event.id, customerId: customer.id, quantity: 1, unitPrice: 5000,
        totalAmount: 5000, currency: "INR", idempotencyKey: randomUUID(),
      } });
      await queueBookingConfirmation(tx, booking, event);
      assert.equal(await processNextNotification({ eventId: event.id, send: () => assert.fail("Uncommitted notification delivered") }), false);
      throw new Error("Simulated transaction failure");
    }), /Simulated transaction failure/);
    assert.equal((await jobs(event.id)).length, 0);
    assert.equal(await prisma.booking.count({ where: { eventId: event.id } }), 0);
    assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: event.id } })).remainingTickets, 10);
  });

  await t.test("event updates queue once per existing customer and freeze the message snapshot", async () => {
    const event = await eventFixture();
    await book(event.id);
    await book(event.id);
    await book(event.id, other.id);
    await updateEvent(event.id, organizer.id, { venue: "Updated venue" });
    // Customers who book after this update must not receive its update notification.
    await book(event.id, late.id);
    const updates = (await jobs(event.id)).filter((job) => job.type === "EVENT_UPDATED");
    assert.equal(updates.length, 2);
    assert.deepEqual(updates.map((job) => job.customerId).sort(), [customer.id, other.id].sort());
    assert.ok(updates.every((job) => (job.payload as { text: string }).text.includes("Updated venue")));
    await updateEvent(event.id, organizer.id, { venue: "Another venue" });
    const original = await prisma.notificationJob.findUniqueOrThrow({ where: { id: updates[0]!.id } });
    assert.match((original.payload as { text: string }).text, /Updated venue/);
    assert.doesNotMatch((original.payload as { text: string }).text, /Another venue/);
  });

  await t.test("no-op updates, rejected changes, and repeated cancellations do not add jobs", async () => {
    const event = await eventFixture();
    await book(event.id);
    await updateEvent(event.id, organizer.id, { title: event.title });
    await assert.rejects(updateEvent(event.id, other.id, { venue: "Unauthorized" }));
    await assert.rejects(updateEvent(event.id, organizer.id, { endsAt: new Date(0) }));
    assert.equal((await jobs(event.id)).length, 1);
    await cancelEvent(event.id, organizer.id);
    await cancelEvent(event.id, organizer.id);
    const updates = (await jobs(event.id)).filter((job) => job.type === "EVENT_UPDATED");
    assert.equal(updates.length, 1);
    assert.match((updates[0]!.payload as { subject: string }).subject, /Event cancelled/);
  });

  await t.test("events without bookers and deleted bookings/users have no update recipients", async () => {
    const event = await eventFixture();
    await updateEvent(event.id, organizer.id, { venue: "Empty event" });
    assert.equal((await jobs(event.id)).length, 0);
    const result = await book(event.id);
    await book(event.id, other.id);
    await prisma.booking.update({ where: { id: result.booking.id }, data: { deletedAt: new Date() } });
    await prisma.user.update({ where: { id: other.id }, data: { deletedAt: new Date() } });
    try {
      await updateEvent(event.id, organizer.id, { venue: "No active recipients" });
      assert.equal((await jobs(event.id)).filter((job) => job.type === "EVENT_UPDATED").length, 0);
    } finally {
      await prisma.user.update({ where: { id: other.id }, data: { deletedAt: null } });
    }
  });

  await t.test("the console adapter logs a simulated notification and marks the job completed", async () => {
    const { event, job } = await pendingFixture();
    const logs: unknown[][] = [];
    const log = t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
    try {
      assert.equal(await processNextNotification({ eventId: event.id }), true);
    } finally {
      log.mock.restore();
    }
    assert.equal(logs.length, 1);
    assert.equal(logs[0]![0], "[notification:console]");
    const message = logs[0]![1] as NotificationMessage & { delivery: string };
    assert.equal(message.delivery, "simulated");
    assert.equal(message.to, customer.email);
    assert.equal(message.jobId, job.id);
    const stored = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(stored.status, "COMPLETED");
    assert.equal(stored.attempts, 1);
    assert.ok(stored.processedAt);
    assert.equal(stored.lockToken, null);
    assert.equal(await processNextNotification({ eventId: event.id }), false);
  });

  await t.test("a second worker cannot deliver a job while its first claim is active", async () => {
    const { event } = await pendingFixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const delivery = new Promise<void>((resolve) => { release = resolve; });
    const first = processNextNotification({ eventId: event.id, send: async () => { entered(); await delivery; } });
    await started;
    try {
      assert.equal(await processNextNotification({ eventId: event.id, send: () => assert.fail("Duplicate delivery") }), false);
    } finally {
      release();
      await first;
    }
  });

  await t.test("failed delivery is retried with backoff and can later complete", async () => {
    const { event, job } = await pendingFixture();
    await processNextNotification({ eventId: event.id, send: () => { throw new Error("Temporary sender failure"); } });
    const retry = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(retry.status, "PENDING");
    assert.equal(retry.attempts, 1);
    assert.equal(retry.lastError, "Temporary sender failure");
    assert.ok(retry.availableAt.getTime() > Date.now());
    assert.equal(await processNextNotification({ eventId: event.id }), false);
    await prisma.notificationJob.update({ where: { id: job.id }, data: { availableAt: new Date(0) } });
    await processNextNotification({ eventId: event.id, send: () => {} });
    const completed = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.attempts, 2);
    assert.equal(completed.lastError, null);
  });

  await t.test("the final failed attempt marks the job failed instead of retrying forever", async () => {
    const { event, job } = await pendingFixture();
    await prisma.notificationJob.update({ where: { id: job.id }, data: { attempts: env.NOTIFICATION_MAX_ATTEMPTS - 1 } });
    await processNextNotification({ eventId: event.id, send: () => { throw new Error("Permanent sender failure"); } });
    assert.equal((await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } })).status, "FAILED");
    assert.equal(await processNextNotification({ eventId: event.id }), false);
  });

  await t.test("expired claims are recovered, including a crash on the final attempt", async () => {
    const { event, job } = await pendingFixture();
    await prisma.notificationJob.update({ where: { id: job.id }, data: {
      status: "PROCESSING", attempts: 1, lockedAt: new Date(0), lockToken: "crashed-worker",
    } });
    await processNextNotification({ eventId: event.id, send: () => {} });
    assert.equal((await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } })).status, "COMPLETED");
    const crashed = await pendingFixture();
    await prisma.notificationJob.update({ where: { id: crashed.job.id }, data: {
      status: "PROCESSING", attempts: env.NOTIFICATION_MAX_ATTEMPTS, lockedAt: new Date(0), lockToken: "crashed-worker",
    } });
    await processNextNotification({ eventId: crashed.event.id, send: () => assert.fail("Attempts exhausted") });
    assert.equal((await prisma.notificationJob.findUniqueOrThrow({ where: { id: crashed.job.id } })).status, "FAILED");
  });

  await t.test("a stale worker cannot acknowledge a newer worker's claim", async () => {
    const { event, job } = await pendingFixture();
    await processNextNotification({ eventId: event.id, send: async () => {
      // Simulate recovery by another worker before the original delivery finishes.
      await prisma.notificationJob.update({ where: { id: job.id }, data: { lockToken: "new-worker", lockedAt: new Date() } });
    } });
    const stored = await prisma.notificationJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(stored.status, "PROCESSING");
    assert.equal(stored.lockToken, "new-worker");
  });
});
