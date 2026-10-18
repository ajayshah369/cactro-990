import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { app } from "../src/server.js";
import { prisma } from "../src/database/database.js";
import { Prisma } from "../src/generated/prisma/client.js";
import { createBooking } from "../src/services/booking.service.js";
import { AUTH_COOKIE_NAME } from "../src/utils/authCookie.js";

test("customer booking API", async (t) => {
  const tag = `booking-test-${randomUUID()}`;
  const emails = ["organizer", "customer", "other"].map((name) => `${name}-${tag}@example.test`);
  const atHour = (hour: number) => new Date(Date.now() + hour * 60 * 60 * 1000);
  const server = app.listen(0, "127.0.0.1");

  t.after(async () => {
    server.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      // Only remove this run's uniquely named fixtures, in foreign-key order.
      await prisma.$transaction([
        prisma.booking.deleteMany({ where: { event: { organizer: { email: { in: emails } } } } }),
        prisma.event.deleteMany({ where: { organizer: { email: { in: emails } } } }),
        prisma.user.deleteMany({ where: { email: { in: emails } } }),
      ]);
    } finally {
      await prisma.$disconnect();
    }
  });

  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(method: string, path: string, body?: unknown, cookie?: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: response.status === 204 ? null : await response.json(),
    };
  }
  async function register(email: string, role: "ORGANIZER" | "CUSTOMER") {
    const result = await request("POST", "/auth/register", {
      name: "Booking test user", email, role, password: "A booking test passphrase!",
    });
    assert.equal(result.status, 201);
    const cookie = result.headers.getSetCookie()
      .find((value) => value.startsWith(`${AUTH_COOKIE_NAME}=`))?.split(";")[0];
    assert.ok(cookie);
    return { id: result.body.data.id as string, cookie };
  }
  const organizer = await register(emails[0]!, "ORGANIZER");
  const customer = await register(emails[1]!, "CUSTOMER");
  const other = await register(emails[2]!, "CUSTOMER");

  async function eventFixture(overrides: Partial<Prisma.EventUncheckedCreateInput> = {}) {
    return prisma.event.create({
      data: {
        organizerId: organizer.id, title: `${tag} Event`, description: "Booking test",
        venue: "Bengaluru Hall", startsAt: atHour(48), endsAt: atHour(72),
        capacity: 10, remainingTickets: 10, ticketPrice: 5000, ...overrides,
      },
    });
  }
  const event = await eventFixture();
  const input = { eventId: event.id, quantity: 2, idempotencyKey: randomUUID() };
  let bookingId = "";
  const book = (eventId: string, quantity = 1, idempotencyKey = randomUUID(), cookie = customer.cookie) =>
    request("POST", "/bookings", { eventId, quantity, idempotencyKey }, cookie);

  async function assertInventory(eventId: string) {
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    const sales = await prisma.booking.aggregate({ where: { eventId }, _sum: { quantity: true } });
    assert.ok(stored.remainingTickets >= 0);
    assert.equal(stored.capacity - stored.remainingTickets, sales._sum.quantity ?? 0);
    return stored;
  }

  await t.test("all booking endpoints require an authenticated customer", async () => {
    for (const [method, path, body] of [
      ["POST", "/bookings", input], ["GET", "/bookings", undefined],
      ["GET", `/bookings/${event.id}`, undefined],
    ] as const) {
      assert.equal((await request(method, path, body)).status, 401);
      assert.equal((await request(method, path, body, organizer.cookie)).status, 403);
    }
  });

  await t.test("validation rejects invalid quantities, keys and server-controlled fields", async () => {
    for (const changes of [
      { eventId: "not-a-cuid" }, { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 },
      { quantity: "2" }, { quantity: 2_147_483_648 }, { idempotencyKey: "" },
      { idempotencyKey: "a".repeat(129) }, { idempotencyKey: "white space" },
      { customerId: other.id }, { unitPrice: 1 }, { totalAmount: 1 }, { currency: "USD" },
    ]) {
      assert.equal((await request("POST", "/bookings", { ...input, ...changes }, customer.cookie)).status, 400);
    }
    assert.equal((await request("POST", "/bookings", { eventId: event.id, quantity: 1 }, customer.cookie)).status, 400);
    assert.equal(await prisma.booking.count({ where: { eventId: event.id } }), 0);
    assert.equal((await assertInventory(event.id)).remainingTickets, 10);
  });

  await t.test("creation snapshots the server price and reserves the requested tickets", async () => {
    const result = await request("POST", "/bookings", input, customer.cookie);
    assert.equal(result.status, 201);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.body.success, true);
    const booking = result.body.data;
    bookingId = booking.id;
    assert.equal(result.headers.get("location"), `/bookings/${bookingId}`);
    assert.equal(booking.customerId, customer.id);
    assert.equal(booking.eventId, event.id);
    assert.equal(booking.quantity, 2);
    assert.equal(booking.unitPrice, 5000);
    assert.equal(booking.totalAmount, 10000);
    assert.equal(booking.currency, "INR");
    assert.equal(booking.event.title, event.title);
    assert.equal(booking.customer, undefined);
    assert.equal((await assertInventory(event.id)).remainingTickets, 8);
  });

  await t.test("identical retries return the original booking without reserving again", async () => {
    const result = await request("POST", "/bookings", input, customer.cookie);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.id, bookingId);
    assert.equal(await prisma.booking.count({ where: { eventId: event.id } }), 1);
    assert.equal((await assertInventory(event.id)).remainingTickets, 8);
  });

  await t.test("a key cannot be reused for a different quantity or event", async () => {
    const second = await eventFixture();
    assert.equal((await book(event.id, 3, input.idempotencyKey)).status, 409);
    assert.equal((await book(second.id, 2, input.idempotencyKey)).status, 409);
    assert.equal((await assertInventory(event.id)).remainingTickets, 8);
    assert.equal((await assertInventory(second.id)).remainingTickets, 10);
  });

  await t.test("new purchases use new keys and keys are scoped to each customer", async () => {
    const newPurchase = await book(event.id, 1);
    const otherPurchase = await book(event.id, 2, input.idempotencyKey, other.cookie);
    assert.equal(newPurchase.status, 201);
    assert.notEqual(newPurchase.body.data.id, bookingId);
    assert.equal(otherPurchase.status, 201);
    assert.equal(otherPurchase.body.data.customerId, other.id);
    assert.equal((await assertInventory(event.id)).remainingTickets, 5);
  });

  await t.test("unavailable events and insufficient inventory leave no booking behind", async () => {
    for (const overrides of [
      { status: "CANCELLED" as const }, { deletedAt: new Date() },
      { startsAt: atHour(-1), endsAt: atHour(1) },
    ]) {
      const unavailable = await eventFixture(overrides);
      assert.equal((await book(unavailable.id)).status, 409);
      assert.equal(await prisma.booking.count({ where: { eventId: unavailable.id } }), 0);
      assert.equal((await assertInventory(unavailable.id)).remainingTickets, 10);
    }
    assert.equal((await book(event.id, 6)).status, 409);
    assert.equal((await book(`c${randomUUID().replaceAll("-", "")}`)).status, 404);
    assert.equal((await assertInventory(event.id)).remainingTickets, 5);
  });

  await t.test("free tickets work and totals outside the database range are rejected", async () => {
    const free = await eventFixture({ ticketPrice: 0 });
    const result = await book(free.id, 2);
    assert.equal(result.status, 201);
    assert.equal(result.body.data.totalAmount, 0);
    const expensive = await eventFixture({ ticketPrice: 2_147_483_647 });
    assert.equal((await book(expensive.id, 2)).status, 400);
    assert.equal((await assertInventory(expensive.id)).remainingTickets, 10);
    assert.equal((await book(expensive.id, 1)).body.data.totalAmount, 2_147_483_647);
  });

  await t.test("customers can read only their own booking and validate detail IDs", async () => {
    const result = await request("GET", `/bookings/${bookingId}`, undefined, customer.cookie);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.id, bookingId);
    assert.equal((await request("GET", `/bookings/${bookingId}`, undefined, other.cookie)).status, 404);
    assert.equal((await request("GET", "/bookings/not-a-cuid", undefined, customer.cookie)).status, 400);
    assert.equal((await request("GET", `/bookings/c${randomUUID().replaceAll("-", "")}`, undefined, customer.cookie)).status, 404);
  });

  await t.test("history is paginated, optionally filtered, and scoped to the customer", async () => {
    const path = `/bookings?eventId=${event.id}&limit=1`;
    const first = await request("GET", path, undefined, customer.cookie);
    const second = await request("GET", `${path}&page=2`, undefined, customer.cookie);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.deepEqual(first.body.data.pagination, { page: 1, limit: 1, total: 2, totalPages: 2 });
    assert.notEqual(first.body.data.bookings[0].id, second.body.data.bookings[0].id);
    for (const page of [first, second]) assert.equal(page.body.data.bookings[0].customerId, customer.id);
    const beyond = await request("GET", `${path}&page=3`, undefined, customer.cookie);
    assert.deepEqual(beyond.body.data.bookings, []);
    const otherHistory = await request("GET", `/bookings?eventId=${event.id}`, undefined, other.cookie);
    assert.equal(otherHistory.body.data.pagination.total, 1);
    assert.equal(otherHistory.body.data.bookings[0].customerId, other.id);
    for (const query of ["page=0", "page=1.5", "page=10001", "limit=101", "page=1&page=2", "eventId=invalid", `customerId=${other.id}`]) {
      assert.equal((await request("GET", `/bookings?${query}`, undefined, customer.cookie)).status, 400);
    }
  });

  await t.test("20 simultaneous requests cannot sell more than five tickets", async () => {
    const limited = await eventFixture({ capacity: 5, remainingTickets: 5 });
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      book(limited.id, 1, randomUUID(), index % 2 ? customer.cookie : other.cookie)));
    assert.equal(results.filter((result) => result.status === 201).length, 5);
    assert.equal(results.filter((result) => result.status === 409).length, 15);
    assert.equal(await prisma.booking.count({ where: { eventId: limited.id } }), 5);
    assert.equal((await assertInventory(limited.id)).remainingTickets, 0);
  });

  await t.test("simultaneous identical retries book the last ticket exactly once", async () => {
    const last = await eventFixture({ capacity: 1, remainingTickets: 1 });
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => book(last.id, 1, key)));
    assert.equal(results.filter((result) => result.status === 201).length, 1);
    assert.equal(results.filter((result) => result.status === 200).length, 7);
    assert.equal(new Set(results.map((result) => result.body.data.id)).size, 1);
    assert.equal((await book(last.id)).status, 409);
    assert.equal((await assertInventory(last.id)).remainingTickets, 0);
  });

  await t.test("a concurrent key collision across events cannot consume inventory twice", async () => {
    const left = await eventFixture();
    const right = await eventFixture();
    const key = randomUUID();
    const results = await Promise.all([book(left.id, 1, key), book(right.id, 1, key)]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    const remaining = [(await assertInventory(left.id)).remainingTickets, (await assertInventory(right.id)).remainingTickets];
    assert.deepEqual(remaining.sort(), [9, 10].sort());
    assert.equal(await prisma.booking.count({ where: { customerId: customer.id, idempotencyKey: key } }), 1);
  });

  await t.test("a failed booking insert rolls back its ticket reservation", async () => {
    const untouched = await eventFixture();
    // The direct service call forces a real FK failure after the inventory write.
    await assert.rejects(createBooking(`c${randomUUID().replaceAll("-", "")}`, {
      eventId: untouched.id, quantity: 2, idempotencyKey: randomUUID(),
    }), (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003");
    assert.equal((await assertInventory(untouched.id)).remainingTickets, 10);
  });

  await t.test("booking and capacity changes keep inventory consistent", async () => {
    const limited = await eventFixture({ capacity: 2, remainingTickets: 2 });
    const results = await Promise.all([
      book(limited.id, 2),
      request("PATCH", `/organizer/events/${limited.id}`, { capacity: 1 }, organizer.cookie),
    ]);
    assert.ok(
      (results[0]!.status === 201 && results[1]!.status === 409) ||
      (results[0]!.status === 409 && results[1]!.status === 200),
    );
    await assertInventory(limited.id);
  });

  await t.test("price changes affect new purchases but preserve previous booking snapshots", async () => {
    assert.equal((await request("PATCH", `/organizer/events/${event.id}`, { ticketPrice: 7000 }, organizer.cookie)).status, 200);
    const replay = await request("POST", "/bookings", input, customer.cookie);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.unitPrice, 5000);
    assert.equal(replay.body.data.totalAmount, 10000);
    const fresh = await book(event.id);
    assert.equal(fresh.status, 201);
    assert.equal(fresh.body.data.unitPrice, 7000);
    await assertInventory(event.id);
  });

  await t.test("cancellation preserves customer history and successful retries", async () => {
    assert.equal((await request("DELETE", `/organizer/events/${event.id}`, undefined, organizer.cookie)).status, 204);
    const replay = await request("POST", "/bookings", input, customer.cookie);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.data.id, bookingId);
    assert.equal(replay.body.data.event.status, "CANCELLED");
    const detail = await request("GET", `/bookings/${bookingId}`, undefined, customer.cookie);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.event.status, "CANCELLED");
    const history = await request("GET", `/bookings?eventId=${event.id}`, undefined, customer.cookie);
    assert.ok(history.body.data.bookings.some((booking: { id: string }) => booking.id === bookingId));
    assert.equal((await book(event.id)).status, 409);
    await assertInventory(event.id);
  });

  await t.test("booking and cancellation serialize on the same event", async () => {
    const cancelled = await eventFixture();
    const [purchase, cancellation] = await Promise.all([
      book(cancelled.id),
      request("DELETE", `/organizer/events/${cancelled.id}`, undefined, organizer.cookie),
    ]);
    assert.equal(cancellation.status, 204);
    assert.ok(purchase.status === 201 || purchase.status === 409);
    const stored = await assertInventory(cancelled.id);
    assert.equal(stored.status, "CANCELLED");
    assert.equal(stored.remainingTickets, purchase.status === 201 ? 9 : 10);
    assert.equal((await book(cancelled.id)).status, 409);
  });

  await t.test("untrusted browser origins cannot create bookings", async () => {
    const untouched = await eventFixture();
    const response = await fetch(`${baseUrl}/bookings`, {
      method: "POST",
      headers: { Origin: "https://untrusted.example", Cookie: customer.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: untouched.id, quantity: 1, idempotencyKey: randomUUID() }),
    });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
    assert.equal((await assertInventory(untouched.id)).remainingTickets, 10);
  });
});
