import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { app } from "../src/server.js";
import { prisma } from "../src/database/database.js";
import type { Prisma } from "../src/generated/prisma/client.js";
import { AUTH_COOKIE_NAME } from "../src/utils/authCookie.js";

test("event management and browsing API", async (t) => {
  const tag = `event-test-${randomUUID()}`;
  const emails = ["owner", "other", "customer"].map((name) => `${name}-${tag}@example.test`);
  const now = Date.now();
  const atHour = (hour: number) => new Date(now + hour * 60 * 60 * 1000);
  const baseInput = {
    title: `${tag} Main`,
    description: "An event for API verification",
    venue: "Bengaluru Hall",
    startsAt: atHour(48).toISOString(),
    endsAt: atHour(72).toISOString(),
    capacity: 10,
    ticketPrice: 1200,
  };
  let eventId = "";
  let bookingId = "";
  let secondId = "";
  let thirdId = "";
  let cancelledId = "";
  let deletedId = "";
  let pastId = "";
  let otherEventId = "";
  const server = app.listen(0, "127.0.0.1");

  t.after(async () => {
    server.closeAllConnections();
    try {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      // Delete only records owned by this run's unique test accounts, in FK order.
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
      name: "Event test user", email, role, password: "An event test passphrase!",
    });
    assert.equal(result.status, 201);
    const cookie = result.headers.getSetCookie()
      .find((value) => value.startsWith(`${AUTH_COOKIE_NAME}=`))?.split(";")[0];
    assert.ok(cookie);
    return { id: result.body.data.id as string, cookie };
  }

  const owner = await register(emails[0]!, "ORGANIZER");
  const other = await register(emails[1]!, "ORGANIZER");
  const customer = await register(emails[2]!, "CUSTOMER");

  async function fixture(overrides: Partial<Prisma.EventUncheckedCreateInput>) {
    return prisma.event.create({
      data: {
        ...baseInput,
        startsAt: atHour(96), endsAt: atHour(120),
        organizerId: owner.id, remainingTickets: baseInput.capacity,
        ...overrides,
      },
    });
  }

  await t.test("only organizers can create and list their own events", async () => {
    assert.equal((await request("POST", "/organizer/events", baseInput)).status, 401);
    assert.equal((await request("POST", "/organizer/events", baseInput, customer.cookie)).status, 403);
    assert.equal((await request("GET", "/organizer/events")).status, 401);
    assert.equal((await request("GET", "/organizer/events", undefined, customer.cookie)).status, 403);
  });

  await t.test("creation derives ownership, defaults currency and initializes inventory", async () => {
    const result = await request("POST", "/organizer/events", {
      ...baseInput, title: ` ${baseInput.title} `, venue: " Bengaluru Hall ",
    }, owner.cookie);
    assert.equal(result.status, 201);
    const event = result.body.data;
    eventId = event.id;
    assert.equal(event.organizerId, owner.id);
    assert.equal(event.title, baseInput.title);
    assert.equal(event.venue, "Bengaluru Hall");
    assert.equal(event.remainingTickets, 10);
    assert.equal(event.currency, "INR");
    assert.equal(event.status, "PUBLISHED");
    assert.equal(event.deletedAt, null);
  });

  await t.test("public event routes do not accept organizer mutations", async () => {
    assert.equal((await request("POST", "/events", baseInput, owner.cookie)).status, 404);
    assert.equal((await request("PATCH", `/events/${eventId}`, { title: "Unexpected update" }, owner.cookie)).status, 404);
    assert.equal((await request("DELETE", `/events/${eventId}`, undefined, owner.cookie)).status, 404);
    const event = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(event.title, baseInput.title);
    assert.equal(event.status, "PUBLISHED");
    assert.equal(event.deletedAt, null);
    assert.equal(await prisma.event.count({ where: { organizerId: owner.id } }), 1);
  });

  await t.test("invalid values and server-controlled fields are rejected without inserts", async () => {
    for (const changes of [
      { title: " " }, { capacity: 0 }, { capacity: 1.5 }, { capacity: "10" },
      { ticketPrice: -1 }, { ticketPrice: 2_147_483_648 }, { currency: "USD" },
      { startsAt: atHour(-1).toISOString() }, { endsAt: baseInput.startsAt },
      { startsAt: "not-a-date" }, { startsAt: "2030-01-01T12:00:00" },
      { organizerId: other.id }, { remainingTickets: 999 }, { status: "CANCELLED" },
    ]) {
      assert.equal((await request("POST", "/organizer/events", { ...baseInput, ...changes }, owner.cookie)).status, 400);
    }
    assert.equal(await prisma.event.count({ where: { organizerId: owner.id } }), 1);
  });

  await t.test("public browsing filters state, paginates, and orders equal dates by ID", async () => {
    secondId = (await fixture({ title: `${tag} Delhi A`, venue: "Delhi Hall" })).id;
    thirdId = (await fixture({ title: `${tag} Delhi B`, venue: "Delhi Hall" })).id;
    cancelledId = (await fixture({ title: `${tag} Cancelled`, status: "CANCELLED" })).id;
    deletedId = (await fixture({ title: `${tag} Deleted`, deletedAt: new Date() })).id;
    pastId = (await fixture({ title: `${tag} Past`, startsAt: atHour(-48), endsAt: atHour(-24) })).id;
    otherEventId = (await fixture({ title: `${tag} Other`, organizerId: other.id, startsAt: atHour(144), endsAt: atHour(168) })).id;

    const first = await request("GET", `/events?search=${tag}&limit=2`);
    const second = await request("GET", `/events?search=${tag}&limit=2&page=2`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.data.pagination, { page: 1, limit: 2, total: 4, totalPages: 2 });
    assert.equal(second.status, 200);
    const ids = [...first.body.data.events, ...second.body.data.events].map((event: { id: string }) => event.id);
    assert.deepEqual(ids, [eventId, ...[secondId, thirdId].sort(), otherEventId]);
    const beyond = await request("GET", `/events?search=${tag}&limit=2&page=3`);
    assert.deepEqual(beyond.body.data.events, []);
    assert.equal(beyond.body.data.pagination.total, 4);
  });

  await t.test("search, venue and date filters work without authentication", async () => {
    const filtered = await request("GET", `/events?search=${tag.toUpperCase()}&venue=delhi`);
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.pagination.total, 2);
    const dates = new URLSearchParams({ search: tag, from: atHour(96).toISOString(), to: atHour(96).toISOString() });
    const ranged = await request("GET", `/events?${dates}`);
    assert.equal(ranged.body.data.pagination.total, 2);
    const fromPast = await request("GET", `/events?search=${tag}&from=${atHour(-96).toISOString()}`);
    assert.equal(fromPast.body.data.pagination.total, 4);
    const empty = await request("GET", `/events?search=missing-${tag}`);
    assert.deepEqual(empty.body.data.pagination, { page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  await t.test("invalid or repeated query parameters are rejected", async () => {
    for (const query of [
      "page=0", "page=1.5", "page=10001", "limit=101", "limit=-1", "page=1&page=2",
      "search=", "from=nope", "status=CANCELLED", `organizerId=${other.id}`,
      `from=${atHour(120).toISOString()}&to=${atHour(96).toISOString()}`,
    ]) {
      assert.equal((await request("GET", `/events?${query}`)).status, 400);
    }
  });

  await t.test("public details hide cancelled/deleted records and validate IDs", async () => {
    assert.equal((await request("GET", `/events/${eventId}`)).status, 200);
    assert.equal((await request("GET", `/events/${pastId}`)).status, 200);
    assert.equal((await request("GET", `/events/${cancelledId}`)).status, 404);
    assert.equal((await request("GET", `/events/${deletedId}`)).status, 404);
    assert.equal((await request("GET", "/events/not-a-cuid")).status, 400);
    assert.equal((await request("GET", `/events/c${randomUUID().replaceAll("-", "")}`)).status, 404);
  });

  await t.test("organizer listing is scoped to the signed-in user and includes history", async () => {
    const result = await request("GET", `/organizer/events?search=${tag}&limit=100`, undefined, owner.cookie);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("cache-control"), "no-store");
    assert.equal(result.body.data.pagination.total, 6);
    assert.ok(result.body.data.events.every((event: { organizerId: string }) => event.organizerId === owner.id));
    assert.ok(result.body.data.events.some((event: { id: string }) => event.id === pastId));
    const cancelled = await request("GET", `/organizer/events?search=${tag}&status=CANCELLED`, undefined, owner.cookie);
    assert.deepEqual(cancelled.body.data.events.map((event: { id: string }) => event.id), [cancelledId]);
    const ownOther = await request("GET", "/organizer/events", undefined, other.cookie);
    assert.equal(ownOther.body.data.pagination.total, 1);
  });

  await t.test("organizers can view their own published, past, cancelled and deleted events", async () => {
    for (const id of [eventId, pastId, cancelledId, deletedId]) {
      const result = await request("GET", `/organizer/events/${id}`, undefined, owner.cookie);
      assert.equal(result.status, 200);
      assert.equal(result.headers.get("cache-control"), "no-store");
      assert.equal(result.body.success, true);
      assert.equal(result.body.data.id, id);
      assert.equal(result.body.data.organizerId, owner.id);
    }
  });

  await t.test("organizer event details enforce authentication, role, ownership and ID validation", async () => {
    assert.equal((await request("GET", `/organizer/events/${eventId}`)).status, 401);
    assert.equal((await request("GET", `/organizer/events/${eventId}`, undefined, customer.cookie)).status, 403);
    for (const id of [eventId, pastId, cancelledId, deletedId]) {
      const result = await request("GET", `/organizer/events/${id}`, undefined, other.cookie);
      assert.equal(result.status, 403);
      assert.equal(result.body.data, undefined);
    }
    assert.equal((await request("GET", "/organizer/events/not-a-cuid", undefined, owner.cookie)).status, 400);
    assert.equal((await request("GET", `/organizer/events/c${randomUUID().replaceAll("-", "")}`, undefined, owner.cookie)).status, 404);
  });

  await t.test("updates and cancellations enforce both role and ownership", async () => {
    for (const method of ["PATCH", "DELETE"]) {
      const body = method === "PATCH" ? { title: "Unauthorized" } : undefined;
      assert.equal((await request(method, `/organizer/events/${eventId}`, body)).status, 401);
      assert.equal((await request(method, `/organizer/events/${eventId}`, body, customer.cookie)).status, 403);
      assert.equal((await request(method, `/organizer/events/${eventId}`, body, other.cookie)).status, 403);
      assert.equal((await request(method, `/organizer/events/c${randomUUID().replaceAll("-", "")}`, body, owner.cookie)).status, 404);
    }
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(stored.title, baseInput.title);
    assert.equal(stored.deletedAt, null);
  });

  await t.test("partial updates reject empty input, server fields and invalid merged dates", async () => {
    for (const body of [
      {}, { organizerId: other.id }, { remainingTickets: 100 }, { deletedAt: new Date().toISOString() },
      { status: "CANCELLED" }, { endsAt: atHour(47).toISOString() }, { startsAt: atHour(73).toISOString() },
    ]) {
      assert.equal((await request("PATCH", `/organizer/events/${eventId}`, body, owner.cookie)).status, 400);
    }
  });

  await t.test("dates with timezone offsets are accepted and returned as UTC", async () => {
    const startsAt = new Date(atHour(48).getTime() + 330 * 60 * 1000).toISOString().replace("Z", "+05:30");
    const result = await request("PATCH", `/organizer/events/${eventId}`, { startsAt, description: " Updated description " }, owner.cookie);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.startsAt, atHour(48).toISOString());
    assert.equal(result.body.data.description, "Updated description");
    assert.equal(result.body.data.currency, "INR");
  });

  await t.test("price updates preserve booking snapshots and current inventory", async () => {
    // Booking APIs come next; create a consistent sold-ticket fixture directly.
    const booking = await prisma.$transaction(async (tx) => {
      await tx.event.update({ where: { id: eventId }, data: { remainingTickets: { decrement: 4 } } });
      return tx.booking.create({ data: {
        customerId: customer.id, eventId, quantity: 4, unitPrice: 1200,
        totalAmount: 4800, currency: "INR", idempotencyKey: randomUUID(),
      } });
    });
    bookingId = booking.id;
    const result = await request("PATCH", `/organizer/events/${eventId}`, { ticketPrice: 2500 }, owner.cookie);
    assert.equal(result.status, 200);
    assert.equal(result.body.data.ticketPrice, 2500);
    assert.equal(result.body.data.remainingTickets, 6);
    const stored = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    assert.equal(stored.unitPrice, 1200);
    assert.equal(stored.totalAmount, 4800);
  });

  await t.test("capacity changes preserve sold tickets and cannot go below sales", async () => {
    const increased = await request("PATCH", `/organizer/events/${eventId}`, { capacity: 15 }, owner.cookie);
    assert.equal(increased.status, 200);
    assert.equal(increased.body.data.remainingTickets, 11);
    const decreased = await request("PATCH", `/organizer/events/${eventId}`, { capacity: 4 }, owner.cookie);
    assert.equal(decreased.status, 200);
    assert.equal(decreased.body.data.remainingTickets, 0);
    assert.equal((await request("PATCH", `/organizer/events/${eventId}`, { capacity: 3 }, owner.cookie)).status, 409);
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(stored.capacity, 4);
    assert.equal(stored.remainingTickets, 0);
  });

  await t.test("concurrent date updates cannot leave the event ending before it starts", async () => {
    const event = await fixture({ title: `${tag} Date race`, startsAt: atHour(48), endsAt: atHour(72) });
    // Each update is valid against the old row, but applying both would be invalid.
    const results = await Promise.all([
      request("PATCH", `/organizer/events/${event.id}`, { startsAt: atHour(60).toISOString() }, owner.cookie),
      request("PATCH", `/organizer/events/${event.id}`, { endsAt: atHour(54).toISOString() }, owner.cookie),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: event.id } });
    assert.ok(stored.endsAt > stored.startsAt);
  });

  await t.test("concurrent capacity updates preserve the number of sold tickets", async () => {
    const results = await Promise.all([
      request("PATCH", `/organizer/events/${eventId}`, { capacity: 8 }, owner.cookie),
      request("PATCH", `/organizer/events/${eventId}`, { capacity: 12 }, owner.cookie),
    ]);
    assert.ok(results.every((result) => result.status === 200));
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(stored.capacity - stored.remainingTickets, 4);
  });

  await t.test("browser origin protection applies to event writes", async () => {
    const result = await fetch(`${baseUrl}/organizer/events/${eventId}`, {
      method: "DELETE", headers: { Origin: "https://untrusted.example", Cookie: owner.cookie },
    });
    assert.equal(result.status, 403);
    await result.arrayBuffer();
    assert.equal((await prisma.event.findUniqueOrThrow({ where: { id: eventId } })).deletedAt, null);
  });

  await t.test("cancellation hides the event while preserving its row and bookings", async () => {
    assert.equal((await request("DELETE", `/organizer/events/${eventId}`, undefined, owner.cookie)).status, 204);
    const stored = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(stored.status, "CANCELLED");
    assert.ok(stored.deletedAt instanceof Date);
    assert.equal(await prisma.booking.count({ where: { id: bookingId } }), 1);
    assert.equal((await request("GET", `/events/${eventId}`)).status, 404);
    const publicList = await request("GET", `/events?search=${tag}`);
    assert.ok(publicList.body.data.events.every((event: { id: string }) => event.id !== eventId));
    const history = await request("GET", `/organizer/events?search=${tag}&status=CANCELLED`, undefined, owner.cookie);
    assert.ok(history.body.data.events.some((event: { id: string }) => event.id === eventId));
    assert.equal((await request("DELETE", `/organizer/events/${eventId}`, undefined, owner.cookie)).status, 204);
    const repeated = await prisma.event.findUniqueOrThrow({ where: { id: eventId } });
    assert.equal(repeated.deletedAt!.getTime(), stored.deletedAt.getTime());
    assert.equal((await request("PATCH", `/organizer/events/${eventId}`, { title: "Reopen" }, owner.cookie)).status, 409);
  });
});
