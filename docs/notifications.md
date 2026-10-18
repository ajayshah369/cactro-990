# Background notifications

Notifications use a PostgreSQL job queue and a separate Node.js worker. This stage deliberately uses `console.log` as the delivery adapter; no real emails are sent. No Redis instance or new dependency is required.

## Start both processes

Apply migrations and generate the Prisma client after pulling these changes:

```bash
npx prisma migrate deploy
npm run generate
```

Start the API in one terminal:

```bash
npm run dev
```

Start the worker in another terminal:

```bash
npm run worker:dev
```

Both processes use the same `.env` and PostgreSQL database. The new notification settings have defaults, so an existing `.env` does not need changing. For compiled code, run `npm run build` once, then run `npm start` and `npm run worker` as separate processes. Stop the worker with Ctrl+C; it finishes the current job before exiting, with a ten-second shutdown limit.

## Follow a booking through the system

1. The customer calls `POST /bookings`.
2. The booking service locks the event, checks availability and idempotency, updates inventory, creates the booking, and inserts a `BOOKING_CONFIRMATION` job in one database transaction.
3. The transaction commits and the API returns `201`. It does not wait for notification delivery.
4. The worker claims an available job in a short transaction and marks it `PROCESSING`.
5. After releasing the database lock, the worker calls the sender, which logs the recipient, subject, and message.
6. On success, the worker marks the job `COMPLETED`.

The job contains the booking price and event details at purchase time. An idempotent booking replay returns `200` without inserting another job; `bookingId` is also unique in the queue table. A failed booking transaction leaves neither a reservation nor a notification job.

Example worker output (IDs and dates omitted here for readability):

```text
[notification:console] {
  delivery: 'simulated',
  jobId: '...',
  type: 'BOOKING_CONFIRMATION',
  to: 'customer@example.com',
  subject: 'Booking confirmed: Node.js Meetup',
  text: 'Hello Demo Customer,\nYour booking ... is confirmed.\n...'
}
```

## Event updates and cancellation

An organizer patch that changes details queues an `EVENT_UPDATED` job for each active customer with a non-deleted booking. A customer with several bookings receives one job for that update. Cancellation queues the same job type with a cancellation subject and status.

The service chooses recipients and stores the message while it holds the event lock. This keeps the recipient list consistent with bookings committed before the change. Customers who book later are not included in an earlier update. The queued message is a snapshot, so later edits do not overwrite its content.

Unchanged patch values, rejected updates, and repeated cancellation do not queue jobs. An event with no eligible customers queues none. These hooks apply to new operations; they do not backfill notifications for historical bookings or updates.

## Persistence, retries, and multiple workers

`notification_jobs` stores the payload, type, status, attempt count, next available time, lock token, and last error. Typical transitions are:

```text
PENDING -> PROCESSING -> COMPLETED
                |
                +-> PENDING (retry later)
                +-> FAILED  (attempt limit reached)
```

The API saves jobs in the same transaction as the business change. If the queue insert fails, that transaction rolls back. If the worker is stopped, committed jobs remain pending and are processed when it returns.

Claims use `FOR UPDATE SKIP LOCKED`, so workers can take different jobs without waiting on another worker's row. A claim increments `attempts` and assigns a random lock token. Success/failure updates must match that token, preventing an expired worker from acknowledging another worker's claim. Work occurs outside the claim transaction.

On failure, the worker stores the error and retries with exponential backoff, capped at 60 seconds. A crashed worker's claim becomes eligible again after its lease expires. Jobs that exhaust the attempt limit stay `FAILED` for inspection; this increment has no admin retry endpoint or automatic retention cleanup.

Delivery is **at least once**. A crash after logging or sending but before marking the job complete can cause duplicate delivery on recovery. The lock token protects database state; it cannot undo an external send. When adding real email, use a provider idempotency key based on the job ID where supported, and bound send time below the lease or implement lease renewal.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `NOTIFICATION_POLL_INTERVAL_MS` | `1000` | Idle polling delay |
| `NOTIFICATION_MAX_ATTEMPTS` | `5` | Maximum claims, including recovery after a crash |
| `NOTIFICATION_RETRY_DELAY_MS` | `1000` | Initial retry delay, doubled after each failure |
| `NOTIFICATION_LEASE_MS` | `60000` | Time until an unfinished claim can be recovered |

Event updates currently select recipients and insert one job per customer during the request transaction. That makes the snapshot reliable, but increases transaction time for large audiences. The worker moves delivery out of the request path; this implementation has not yet been stress-tested for a maximum audience size or booking concurrency.

## Try it with Swagger

1. Start both processes and open `/api-docs` on the API server.
2. Sign in as an organizer and create an event with future dates.
3. Sign in as a customer and book tickets. Watch the worker terminal for `BOOKING_CONFIRMATION`.
4. Repeat the exact booking request with the same idempotency key. It returns the original booking without another confirmation job.
5. Sign in as the event's organizer and change its venue. Watch for `EVENT_UPDATED` addressed to the customer.
6. Stop the worker, make another booking, and start the worker again. The pending confirmation is processed after restart.

Inspect queue state in your database client:

```sql
SELECT id, type, status, attempts, "availableAt", "processedAt", "lastError"
FROM notification_jobs
ORDER BY "createdAt" DESC;
```

## Files and verification

- `prisma/notification.prisma`: persisted job model and enums.
- `src/notifications/notification.queue.ts`: creates booking and event update jobs inside the caller's transaction.
- `src/notifications/notification.processor.ts`: claims, processes, acknowledges, and retries jobs.
- `src/notifications/notification.sender.ts`: validates message payloads and logs simulated delivery. Replace this adapter when adding real email.
- `src/notifications/notification.worker.ts`: polling loop.
- `src/worker.ts`: executable worker startup and shutdown.

Run `npm run test:notifications` against the configured PostgreSQL database with other workers stopped. Tests create unique fixtures, process only their own event jobs, and clean up afterward. Coverage includes transaction rollback, idempotent booking retries, recipient deduplication and snapshots, no-op updates, concurrent claims, retry backoff, exhausted attempts, expired leases, and stale claim protection.

References: [PostgreSQL SELECT locking clauses](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE) and [Prisma transactions](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions).
