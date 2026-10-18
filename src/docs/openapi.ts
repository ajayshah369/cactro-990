import type { OpenAPIV3 } from "openapi-types";
import { z } from "zod";
import { EventStatus, UserRole } from "../generated/prisma/enums.js";
import { loginSchema, registerSchema } from "../schemas/auth.schema.js";
import {
  browseEventsSchema, createEventSchema, eventParamsSchema,
  organizerEventsSchema, updateEventSchema,
} from "../schemas/event.schema.js";
import { bookingParamsSchema, createBookingSchema, listBookingsSchema } from "../schemas/booking.schema.js";
import { AUTH_COOKIE_NAME } from "../utils/authCookie.js";

// Input mode describes the JSON sent by clients, before Zod's transformations.
function jsonSchema(schema: z.ZodType, io: "input" | "output" = "input"): OpenAPIV3.SchemaObject {
  const result = z.toJSONSchema(schema, { io, target: "openapi-3.0" });
  delete result.$schema;
  return result as OpenAPIV3.SchemaObject;
}

const dateTime = z.iso.datetime();
const integer = z.number().int().min(0).max(2_147_483_647);
const user = z.strictObject({
  id: z.cuid(), name: z.string(), email: z.email(), role: z.enum(UserRole), createdAt: dateTime,
});
const event = z.strictObject({
  id: z.cuid(), organizerId: z.cuid(), title: z.string(), description: z.string(), venue: z.string(),
  startsAt: dateTime, endsAt: dateTime, capacity: integer, remainingTickets: integer,
  ticketPrice: integer, currency: z.string().length(3), status: z.enum(EventStatus),
  createdAt: dateTime, updatedAt: dateTime, deletedAt: dateTime.nullable(),
});
const eventSummary = event.pick({
  id: true, title: true, venue: true, startsAt: true, endsAt: true, status: true, deletedAt: true,
});
const booking = z.strictObject({
  id: z.cuid(), customerId: z.cuid(), eventId: z.cuid(), quantity: integer,
  unitPrice: integer, totalAmount: integer, currency: z.string().length(3), idempotencyKey: z.string(),
  createdAt: dateTime, deletedAt: dateTime.nullable(), event: eventSummary,
});
const pagination = z.strictObject({
  page: z.number().int().min(1), limit: z.number().int().min(1),
  total: z.number().int().min(0), totalPages: z.number().int().min(0),
});
const success = (data: z.ZodType) => z.strictObject({ success: z.literal(true), data });

const registerInput = jsonSchema(registerSchema);
const loginInput = jsonSchema(loginSchema);
// Normalization pipes hide their output constraints in input-mode JSON Schema.
for (const schema of [registerInput, loginInput]) {
  schema.properties!.email = {
    type: "string", format: "email", maxLength: 254,
    description: "Email is trimmed and normalized to lowercase before validation.",
  };
}
const createEventInput = {
  ...jsonSchema(createEventSchema),
  description: "Use ISO timestamps with Z or a timezone offset. startsAt must be in the future and endsAt must be later. ticketPrice is in paise (5000 = INR 50). Ownership and remaining tickets are set by the server.",
};
const updateEventInput = {
  ...jsonSchema(updateEventSchema), minProperties: 1,
  description: "Send at least one editable field. A changed startsAt must be in the future. The resulting date range must be valid, and capacity cannot fall below tickets already sold. Prices use integer paise.",
};
const createBookingInput = {
  ...jsonSchema(createBookingSchema),
  description: "Use one idempotencyKey per intended purchase and reuse it on retries. A new purchase needs a new key. Customer, price, currency and total are derived by the server.",
};

const ref = (name: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
function response(name: string, description: string, headers?: OpenAPIV3.ResponseObject["headers"]): OpenAPIV3.ResponseObject {
  return { description, content: { "application/json": { schema: ref(name) } }, ...(headers ? { headers } : {}) };
}
function error(description: string): OpenAPIV3.ResponseObject {
  return response("Error", description);
}
function body(name: string, example: unknown): OpenAPIV3.RequestBodyObject {
  return { required: true, content: { "application/json": { schema: ref(name), example } } };
}
function pathId(schema: z.ZodObject, description: string): OpenAPIV3.ParameterObject[] {
  return [{ name: "id", in: "path", required: true, description, schema: jsonSchema(schema.shape.id) }];
}
function queryParameters(schema: z.ZodObject): OpenAPIV3.ParameterObject[] {
  return Object.entries(schema.shape).map(([name, field]) => ({
    name, in: "query", required: false,
    // Integer query parameters are serialized into the strings Express receives.
    schema: jsonSchema(field, name === "page" || name === "limit" ? "output" : "input"),
  }));
}
const cookieSecurity = [{ cookieAuth: [] }];
const protectedErrors = {
  "401": error("Missing, invalid or expired authentication cookie."),
  "403": error("Wrong user role, ownership restriction, or untrusted origin for a write request."),
};
const invalidInput = error("Invalid body, route ID or query. Unknown and repeated query parameters are rejected.");
const setCookie = {
  "Set-Cookie": {
    description: "Sets the HTTP-only access_token cookie with Path=/ and SameSite=Lax; Secure in production. The JWT is not returned in JSON.",
    schema: { type: "string" as const },
  },
};
const bookingLocation = {
  Location: { description: "URL of the created or replayed booking.", schema: { type: "string" as const }, example: "/bookings/<booking-id>" },
};

// Refresh future dates when the server starts so the create example stays usable.
const startsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
const eventExample = {
  title: "Node.js Backend Workshop", description: "A practical workshop on Express and PostgreSQL.",
  venue: "Bengaluru Tech Hub", startsAt: startsAt.toISOString(),
  endsAt: new Date(startsAt.getTime() + 3 * 60 * 60 * 1000).toISOString(),
  capacity: 100, ticketPrice: 5000, currency: "INR",
};

export const openApiDocument: OpenAPIV3.Document = {
  openapi: "3.0.3",
  info: {
    title: "Event Booking API", version: "1.0.0",
    description: [
      "Create and manage events as an ORGANIZER, or browse and book tickets as a CUSTOMER.",
      "**Using this page:** execute POST /auth/login (or /auth/register) first. The browser stores the HTTP-only cookie and sends it on subsequent requests. You do not need to enter a JWT in the Authorize dialog. Use /auth/me to check the current account and /auth/logout to switch accounts.",
      "Open this page on the same origin configured in BE_URL; production requires HTTPS for Secure cookies. Prices and totals are integer minor units (5000 paise = INR 50).",
      "Booking confirmations and event updates queue background notifications. Run the separate notification worker to log simulated messages; no real emails are sent.",
    ].join("\n\n"),
  },
  servers: [{ url: "/", description: "This API server" }],
  tags: [
    { name: "Health", description: "Server availability." },
    { name: "Authentication", description: "Register, log in, inspect your account and log out." },
    { name: "Public events", description: "Browse events without signing in." },
    { name: "Organizer events", description: "Requires ORGANIZER. Manage only your own events." },
    { name: "Customer bookings", description: "Requires CUSTOMER. Book tickets and view only your own bookings." },
  ],
  components: {
    securitySchemes: {
      cookieAuth: {
        type: "apiKey", in: "cookie", name: AUTH_COOKIE_NAME,
        description: "Log in through /auth/login on this server. The browser manages the HTTP-only cookie; manually entering it in Swagger's Authorize dialog is not supported by browsers.",
      },
    },
    schemas: {
      RegisterInput: registerInput, LoginInput: loginInput,
      CreateEventInput: createEventInput, UpdateEventInput: updateEventInput,
      CreateBookingInput: createBookingInput,
      UserResponse: jsonSchema(success(user)), EventResponse: jsonSchema(success(event)),
      BookingResponse: jsonSchema(success(booking)),
      EventListResponse: jsonSchema(success(z.strictObject({ events: z.array(event), pagination }))),
      BookingListResponse: jsonSchema(success(z.strictObject({ bookings: z.array(booking), pagination }))),
      Error: jsonSchema(z.strictObject({ success: z.literal(false), message: z.string() })),
    },
  },
  paths: {
    "/health": {
      get: {
        tags: ["Health"], operationId: "getHealth", summary: "Check server health",
        responses: { "200": { description: "Server is running.", content: { "application/json": {
          schema: jsonSchema(z.strictObject({ status: z.literal("ok"), message: z.string() })),
          example: { status: "ok", message: "Server is running" },
        } } } },
      },
    },
    "/auth/register": {
      post: {
        tags: ["Authentication"], operationId: "register", summary: "Register and sign in",
        description: "Choose CUSTOMER or ORGANIZER; the default is CUSTOMER. Sets the authentication cookie.",
        requestBody: body("RegisterInput", { name: "Demo Customer", email: "customer@example.com", password: "Demo-passphrase-123!", role: "CUSTOMER" }),
        responses: {
          "201": response("UserResponse", "Account created and signed in.", setCookie),
          "400": invalidInput, "403": error("Request origin is not allowed."),
          "409": error("An account with this email already exists."), "429": error("Too many registration attempts."),
        },
      },
    },
    "/auth/login": {
      post: {
        tags: ["Authentication"], operationId: "login", summary: "Log in and set the authentication cookie",
        requestBody: body("LoginInput", { email: "customer@example.com", password: "Demo-passphrase-123!" }),
        responses: {
          "200": response("UserResponse", "Signed in. The browser stores the cookie for subsequent requests.", setCookie),
          "400": invalidInput, "401": error("Invalid email or password."),
          "403": error("Request origin is not allowed."), "429": error("Too many failed login attempts."),
        },
      },
    },
    "/auth/logout": {
      post: {
        tags: ["Authentication"], operationId: "logout", summary: "Log out by clearing the cookie",
        description: "Also succeeds when no authentication cookie is present.",
        responses: {
          "204": { description: "Cookie expired. No response body.", headers: {
            "Set-Cookie": { description: "Expires the access_token cookie.", schema: { type: "string" } },
          } },
          "403": error("Request origin is not allowed."),
        },
      },
    },
    "/auth/me": {
      get: {
        tags: ["Authentication"], operationId: "getCurrentUser", summary: "Get the signed-in user",
        security: cookieSecurity,
        responses: { "200": response("UserResponse", "Current user without password hash or token."), "401": protectedErrors["401"] },
      },
    },
    "/events": {
      get: {
        tags: ["Public events"], operationId: "browseEvents", summary: "Browse upcoming published events",
        description: "Filters title and venue case-insensitively. from/to are inclusive start-time bounds; from must not exceed to. Sold-out events remain visible. Sorted by start time and ID ascending.",
        parameters: queryParameters(browseEventsSchema),
        responses: { "200": response("EventListResponse", "Matching events and pagination."), "400": invalidInput },
      },
    },
    "/events/{id}": {
      get: {
        tags: ["Public events"], operationId: "getPublicEvent", summary: "View a published event",
        description: "Includes past published events. Cancelled or deleted events are hidden.",
        parameters: pathId(eventParamsSchema, "Event CUID returned by event creation or browsing."),
        responses: { "200": response("EventResponse", "Event details."), "400": invalidInput, "404": error("Event not found.") },
      },
    },
    "/organizer/events": {
      get: {
        tags: ["Organizer events"], operationId: "listOrganizerEvents", summary: "List your events",
        description: "Includes past, cancelled and soft-deleted events owned by the organizer. Sorted by creation time and ID descending. from must not exceed to.",
        security: cookieSecurity, parameters: queryParameters(organizerEventsSchema),
        responses: { "200": response("EventListResponse", "Your events and pagination."), "400": invalidInput, ...protectedErrors },
      },
      post: {
        tags: ["Organizer events"], operationId: "createEvent", summary: "Create an event",
        security: cookieSecurity, requestBody: body("CreateEventInput", eventExample),
        responses: { "201": response("EventResponse", "Published event created with remainingTickets equal to capacity."), "400": invalidInput, ...protectedErrors },
      },
    },
    "/organizer/events/{id}": {
      parameters: pathId(eventParamsSchema, "CUID of an event you own."),
      get: {
        tags: ["Organizer events"], operationId: "getOrganizerEvent", summary: "View one of your events",
        description: "Includes past, cancelled and soft-deleted events.", security: cookieSecurity,
        responses: { "200": response("EventResponse", "Your event details."), "400": invalidInput, ...protectedErrors, "404": error("Event not found.") },
      },
      patch: {
        tags: ["Organizer events"], operationId: "updateEvent", summary: "Update your event",
        description: "Preserves sold tickets and existing booking prices. Changed details queue one background notification per active customer with a booking. Unchanged values do not queue notifications. Cancelled events cannot be edited.",
        security: cookieSecurity, requestBody: body("UpdateEventInput", { capacity: 150, ticketPrice: 7500 }),
        responses: {
          "200": response("EventResponse", "Event updated."), "400": invalidInput, ...protectedErrors,
          "404": error("Event not found."), "409": error("Event is cancelled/deleted, or capacity is below the number of tickets sold."),
        },
      },
      delete: {
        tags: ["Organizer events"], operationId: "cancelEvent", summary: "Cancel your event",
        description: "Marks the event CANCELLED and sets deletedAt. Preserves bookings and queues a background notification per active customer with a booking. Repeated cancellation returns 204 without queuing more notifications.",
        security: cookieSecurity,
        responses: { "204": { description: "Event cancelled. No response body." }, "400": invalidInput, ...protectedErrors, "404": error("Event not found.") },
      },
    },
    "/bookings": {
      get: {
        tags: ["Customer bookings"], operationId: "listCustomerBookings", summary: "List your bookings",
        description: "Optionally filter by eventId. Includes bookings for cancelled events, excludes soft-deleted bookings. Sorted by creation time and ID descending.",
        security: cookieSecurity, parameters: queryParameters(listBookingsSchema),
        responses: { "200": response("BookingListResponse", "Your bookings and pagination."), "400": invalidInput, ...protectedErrors },
      },
      post: {
        tags: ["Customer bookings"], operationId: "createBooking", summary: "Book tickets",
        description: "Replace eventId with a real ID from GET /events. Inventory, booking creation, and a confirmation notification job commit together. Repeating the same customer/key/event/quantity returns the original booking with 200 without another notification job; different details with the same key return 409. Successful retries also work after an event sells out or is cancelled. Notifications are currently logged by the separate worker.",
        security: cookieSecurity,
        requestBody: body("CreateBookingInput", { eventId: "cmvdkgkcm0003e7oz2n210nr9", quantity: 2, idempotencyKey: "checkout-001" }),
        responses: {
          "201": response("BookingResponse", "Tickets reserved and booking created.", bookingLocation),
          "200": response("BookingResponse", "Existing booking returned; no additional tickets reserved.", bookingLocation),
          "400": invalidInput, ...protectedErrors, "404": error("Event not found."),
          "409": error("Insufficient tickets, started/cancelled/deleted event, or conflicting/inactive booking for this idempotency key."),
        },
      },
    },
    "/bookings/{id}": {
      get: {
        tags: ["Customer bookings"], operationId: "getCustomerBooking", summary: "View your booking",
        description: "Includes the original booking price and current event details/status. Another customer's booking returns 404.",
        security: cookieSecurity, parameters: pathId(bookingParamsSchema, "Booking CUID returned by POST /bookings."),
        responses: { "200": response("BookingResponse", "Your booking details."), "400": invalidInput, ...protectedErrors, "404": error("Booking not found.") },
      },
    },
  },
};
