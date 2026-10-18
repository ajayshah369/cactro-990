# Customer bookings

The request flow is `route -> authentication and CUSTOMER role check -> Zod validation -> controller -> service -> Prisma`.

| Endpoint | Purpose | Success |
| --- | --- | --- |
| `POST /bookings` | Reserve tickets and create a booking | `201` for a new booking, `200` for a successful retry |
| `GET /bookings` | List the signed-in customer's bookings | `200` |
| `GET /bookings/:id` | View one of the customer's bookings | `200` |

All endpoints require the HTTP-only authentication cookie and return `Cache-Control: no-store`. Organizers receive `403`; requests without authentication receive `401`.

## Create a booking

Log in as a customer and save the cookie:

```bash
curl -c /tmp/cactro-customer.cookies http://localhost:8000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer@example.com","password":"Your-customer-password"}'
```

Register through `/auth/register` first if needed, using `name`, `email`, `password`, and `role: "CUSTOMER"`.

Choose an event ID from `GET /events`, then send:

```bash
curl -i -b /tmp/cactro-customer.cookies http://localhost:8000/bookings \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"<event-id>","quantity":2,"idempotencyKey":"checkout-001"}'
```

Replace `<event-id>` with an actual CUID. The body accepts exactly these three fields:

- `eventId`: an event CUID.
- `quantity`: a positive integer, at most `2147483647` (also limited by availability).
- `idempotencyKey`: 1–128 letters, digits, hyphens, or underscores. A UUID is a suitable value.

Generate and retain one key per intended purchase. Use the same key and body when retrying after a timeout or connection failure. A new purchase requires a new key.

The server derives `customerId` from the cookie and reads price/currency from the event. Client-supplied prices, totals, customer IDs, and other unknown fields are rejected. `unitPrice` and `totalAmount` are integer minor units; INR 5000 means ₹50. A two-ticket booking at that price has `totalAmount: 10000`. Totals above `2147483647` are rejected to fit the existing database column.

Create and detail responses use `{ "success": true, "data": { ...booking } }`. The booking contains its ID, customer/event IDs, quantity, price snapshot, total, currency, key, timestamps, and an `event` summary with title, venue, dates, status, and `deletedAt`. The event summary reflects current event details; the booking price remains the price at purchase. The `Location` response header identifies `/bookings/<booking-id>`.

## Retries and concurrent requests

The database already has a unique constraint on `(customerId, idempotencyKey)`:

- Same customer, key, event, and quantity: return the original booking with `200`, without decrementing tickets again.
- Same customer and key, different event or quantity: return `409`.
- Different customers may use the same key independently.
- A successful purchase remains replayable after the event sells out, starts, or is cancelled. Its current event summary may have changed.
- Rejected attempts do not persist a booking or reserve a key. Retry the same intended purchase with the same key.

For a new purchase, the service runs a short transaction:

1. Lock the event row with `SELECT ... FOR UPDATE`, matching organizer updates/cancellation.
2. Recheck the idempotency key in case another request completed while this one waited.
3. Check that the event exists, is published, is not deleted, has not started, and has enough tickets.
4. Decrement `remainingTickets`, insert the booking with the event's price snapshot, and insert its confirmation notification job.
5. Commit all three changes together. A failure rolls all three back.

The transaction explicitly uses `READ COMMITTED` so the recheck can see a preceding request's commit after waiting for the event lock. A unique-key conflict between requests for different events is handled after rollback, so the losing request does not consume inventory.

These mechanisms follow [Prisma 7's transaction API](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions) and [PostgreSQL's row-locking rules](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS).

## Read your bookings

```bash
curl -b /tmp/cactro-customer.cookies 'http://localhost:8000/bookings?page=1&limit=20'
curl -b /tmp/cactro-customer.cookies 'http://localhost:8000/bookings?eventId=<event-id>'
curl -b /tmp/cactro-customer.cookies 'http://localhost:8000/bookings/<booking-id>'
```

List responses contain `data.bookings` and `data.pagination: { page, limit, total, totalPages }`. Pagination defaults to page 1, limit 20; the maximum page is 10000 and maximum limit is 100. `eventId` is an optional filter. Results sort by creation time and ID descending. Unknown or repeated query parameters are rejected.

Customers only see their own bookings. Missing bookings and bookings owned by another customer return `404`. Booking history remains accessible when the event is cancelled, including its current status. Soft-deleted booking records are excluded from reads, and their old keys cannot create another purchase.

## Errors

| Status | Meaning |
| --- | --- |
| `400` | Invalid body, route ID, query, or total amount beyond the supported range |
| `401` | Missing or invalid authentication |
| `403` | Wrong role or an untrusted browser origin on a write |
| `404` | Missing event on creation; missing or inaccessible booking on retrieval |
| `409` | Insufficient tickets, started/cancelled/deleted event, or conflicting idempotency key |

## Verification and next step

Run `npm run test:bookings` against the configured PostgreSQL database. The suite creates uniquely named fixtures and removes only its own accounts, events, and bookings afterward. It tests roles, ownership, validation, price snapshots, retries, pagination, overselling, transaction rollback, and races with organizer changes.

The concurrency checks send 20 booking requests for five tickets and eight retries for one ticket. They verify correctness; they do not measure the system's maximum concurrent-user capacity. The deployment stress scenario and before/after performance measurements remain a separate step.

Apply all migrations with `npx prisma migrate deploy`, including the notification queue migration. Every new booking queues one confirmation; an idempotent replay does not create another job. The separate worker currently logs simulated messages. See [notifications.md](notifications.md) for setup and delivery behavior. Payments, refunds, and customer booking cancellations are not implemented.
