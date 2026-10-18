# Event management and browsing

This increment implements event creation, updates, cancellation, public browsing, and the organizer's event history. Customer booking endpoints are documented in [bookings.md](bookings.md). Notification jobs are the next step.

The request flow is:

`route -> authentication/role check (organizer endpoints) -> Zod validation -> controller -> service -> Prisma`

| Endpoint | Access | Success |
| --- | --- | --- |
| `POST /organizer/events` | Organizer | `201`, event in `data` |
| `PATCH /organizer/events/:id` | Organizer who owns the event | `200`, updated event in `data` |
| `DELETE /organizer/events/:id` | Organizer who owns the event | `204`, no body |
| `GET /events` | Public | `200`, events and pagination in `data` |
| `GET /events/:id` | Public | `200`, event in `data` |
| `GET /organizer/events` | Organizer | `200`, own events and pagination in `data` |
| `GET /organizer/events/:id` | Organizer who owns the event | `200`, event in `data` |

## Validation and ownership

- `title`, `description`, and `venue` are trimmed and required. Their maximum lengths are 200, 10,000, and 300 characters.
- Dates must be ISO timestamps with `Z` or an explicit timezone offset. Responses use UTC.
- A new event's start time must be in the future. If an update changes `startsAt`, that new value must also be in the future.
- `endsAt` must be after the effective start time, including when only one date is updated.
- `capacity` must be a positive integer. `ticketPrice` must be a nonnegative integer in paise; `10000` means INR 100.00. Both are limited to PostgreSQL's 32-bit integer range.
- Currency is `INR` for this version and defaults to it on creation.
- `PATCH` must contain at least one editable field. The fields are the same as the create fields; all are optional in a patch.
- `organizerId`, `remainingTickets`, `status`, IDs, and timestamps cannot be supplied by clients. Ownership comes from the authenticated user. New events start `PUBLISHED` with `remainingTickets = capacity`.
- Event IDs must be CUIDs. Ownership is checked in the service as well as the role check in the route.

## Browsing

`GET /events` returns upcoming, published events whose `deletedAt` is null. Sold-out events remain visible with `remainingTickets: 0`. Results sort by `startsAt`, then `id`, ascending.

`GET /events/:id` returns published, non-deleted events, including past events. Cancelled/deleted events return `404`.

Both listing endpoints accept:

| Query | Meaning |
| --- | --- |
| `page` | Positive integer, default `1`, maximum `10000` |
| `limit` | Page size, default `20`, maximum `100` |
| `search` | Case-insensitive title search, maximum 100 characters |
| `venue` | Case-insensitive venue search, maximum 300 characters |
| `from` | Inclusive lower bound on the event's start time |
| `to` | Inclusive upper bound on the event's start time |

`from` must not be after `to`. Date filters use the same ISO timestamp format as event dates. A past `from` value does not include past events in public browsing. Unknown parameters, repeated parameters, and invalid pagination values return `400`.

`GET /organizer/events` includes only the signed-in organizer's events, including past and cancelled events, sorted by creation time and ID descending. It also accepts `status=PUBLISHED` or `status=CANCELLED`. Clients cannot select a different organizer through a query parameter.

`GET /organizer/events/:id` returns a single event owned by the signed-in organizer, including past, cancelled, and soft-deleted events. It returns `401` without authentication, `403` for customers or another organizer's event, `400` for an invalid CUID, and `404` when the event does not exist. Successful responses use `{ "success": true, "data": { ...event } }`.

List responses have this shape:

```json
{
  "success": true,
  "data": {
    "events": [],
    "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 }
  }
}
```

## Inventory, concurrent updates, and cancellation

Updates lock the event row using `SELECT ... FOR UPDATE` inside a short transaction. Date and capacity checks use the locked row. This prevents two individually valid date changes from producing an invalid combined date range.

Sold tickets are tracked as `capacity - remainingTickets`. For example, if capacity is 100 and 30 tickets are sold, increasing capacity to 150 makes 120 tickets available. Reducing capacity below 30 returns `409`. Changing a price or description does not reset inventory, and existing booking price snapshots are unchanged.

The booking feature reserves inventory and creates its booking in one transaction, using this same event row for concurrency control. Directly inserting a booking without adjusting inventory would violate that contract.

`DELETE` marks the row `CANCELLED` and sets `deletedAt`. It preserves the event, all bookings, and inventory history. The event disappears from public browsing but remains in the owner's history. Repeating the deletion returns `204` without changing the original deletion timestamp. Editing a cancelled/deleted event returns `409`.

## Try it

Run `npm run dev`. These examples use port `8000`; adjust it to your `.env` setting. First register an organizer and save the HTTP-only auth cookie:

```bash
curl -c /tmp/cactro-organizer.cookies http://localhost:8000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo Organizer","email":"organizer@example.com","password":"Demo-passphrase-123!","role":"ORGANIZER"}'
```

Use `/auth/login` with the email/password if the account already exists. Keep the cookie jar private.

Create an event (choose future dates):

```bash
curl -b /tmp/cactro-organizer.cookies http://localhost:8000/organizer/events \
  -H 'Content-Type: application/json' \
  -d '{"title":"Node.js Meetup","description":"Backend engineering talks","venue":"Bengaluru Hall","startsAt":"2030-06-01T10:00:00+05:30","endsAt":"2030-06-01T13:00:00+05:30","capacity":100,"ticketPrice":5000}'
```

Copy `data.id` from the response and use it in place of `<event-id>`:

```bash
curl 'http://localhost:8000/events?search=Node&limit=10&page=1'
curl 'http://localhost:8000/events/<event-id>'

curl -b /tmp/cactro-organizer.cookies http://localhost:8000/organizer/events
curl -b /tmp/cactro-organizer.cookies 'http://localhost:8000/organizer/events/<event-id>'

curl -X PATCH -b /tmp/cactro-organizer.cookies 'http://localhost:8000/organizer/events/<event-id>' \
  -H 'Content-Type: application/json' \
  -d '{"capacity":150,"ticketPrice":10000}'

curl -X DELETE -b /tmp/cactro-organizer.cookies 'http://localhost:8000/organizer/events/<event-id>'
```

## Verify

```bash
npm run check
npm run test:events
npm run test:auth
```

The event suite uses the configured PostgreSQL database and a random local HTTP port. It creates unique test accounts, events, and a booking fixture, then removes only those records. It covers authentication, ownership, validation, filtering, pagination, partial updates, concurrent date/capacity changes, and cancellation with existing bookings.

No database migration is needed for these endpoints. The checks in this increment are enforced by request validation and transactional service logic; additional SQL `CHECK` constraints have not been added.
