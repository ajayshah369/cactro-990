import createHttpError from "http-errors";
import { prisma } from "../database/database.js";
import { Prisma, type Event } from "../generated/prisma/client.js";
import type { CreateBookingInput, ListBookingsQuery } from "../schemas/booking.schema.js";
import { queueBookingConfirmation } from "../notifications/notification.queue.js";

const bookingInclude = {
  event: {
    select: {
      id: true,
      title: true,
      venue: true,
      startsAt: true,
      endsAt: true,
      status: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.BookingInclude;

type BookingWithEvent = Prisma.BookingGetPayload<{ include: typeof bookingInclude }>;

function replayBooking(booking: BookingWithEvent, input: CreateBookingInput) {
  if (booking.eventId !== input.eventId || booking.quantity !== input.quantity) {
    throw createHttpError(409, "Idempotency key was already used for a different booking request");
  }
  if (booking.deletedAt) {
    throw createHttpError(409, "This booking is no longer active; use a new key for a new purchase");
  }
  return { booking, created: false };
}

export async function createBooking(customerId: string, input: CreateBookingInput) {
  const where = {
    customerId_idempotencyKey: { customerId, idempotencyKey: input.idempotencyKey },
  };
  const existing = await prisma.booking.findUnique({ where, include: bookingInclude });
  // A successful purchase stays replayable even if its event is now sold out or cancelled.
  if (existing) return replayBooking(existing, input);

  try {
    return await prisma.$transaction(async (tx) => {
      // Share the event row lock with organizer updates and cancellation.
      const [event] = await tx.$queryRaw<Event[]>`
        SELECT * FROM "events" WHERE "id" = ${input.eventId} FOR UPDATE
      `;

      // Another request may have completed while this request waited for the lock.
      const repeated = await tx.booking.findUnique({ where, include: bookingInclude });
      if (repeated) return replayBooking(repeated, input);

      if (!event) throw createHttpError(404, "Event not found");
      if (event.status !== "PUBLISHED" || event.deletedAt) {
        throw createHttpError(409, "This event is no longer available for booking");
      }
      if (event.startsAt.getTime() <= Date.now()) {
        throw createHttpError(409, "Bookings close when the event starts");
      }
      if (event.remainingTickets < input.quantity) {
        throw createHttpError(409, "Not enough tickets available");
      }

      // Both prices and totals use PostgreSQL Int columns (integer minor units).
      if (event.ticketPrice > 0 && input.quantity > Math.floor(2_147_483_647 / event.ticketPrice)) {
        throw createHttpError(400, "Booking total exceeds the supported amount");
      }

      await tx.event.update({
        where: { id: event.id },
        data: { remainingTickets: { decrement: input.quantity } },
      });
      const booking = await tx.booking.create({
        data: {
          customerId,
          eventId: event.id,
          quantity: input.quantity,
          idempotencyKey: input.idempotencyKey,
          unitPrice: event.ticketPrice,
          totalAmount: event.ticketPrice * input.quantity,
          currency: event.currency,
        },
        include: bookingInclude,
      });
      await queueBookingConfirmation(tx, booking, event);
      return { booking, created: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  } catch (error) {
    // Different events have different locks, but the key is unique across a customer's
    // purchases. A concurrent key collision rolls back the entire losing transaction.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await prisma.booking.findUnique({ where, include: bookingInclude });
      if (winner) return replayBooking(winner, input);
    }
    throw error;
  }
}

export async function listCustomerBookings(customerId: string, query: ListBookingsQuery) {
  const where: Prisma.BookingWhereInput = {
    customerId,
    deletedAt: null,
    ...(query.eventId ? { eventId: query.eventId } : {}),
  };
  const [bookings, total] = await prisma.$transaction([
    prisma.booking.findMany({
      where,
      include: bookingInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.booking.count({ where }),
  ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  return {
    bookings,
    pagination: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  };
}

export async function getCustomerBooking(bookingId: string, customerId: string) {
  const booking = await prisma.booking.findFirst({
    where: { id: bookingId, customerId, deletedAt: null },
    include: bookingInclude,
  });
  if (!booking) throw createHttpError(404, "Booking not found");
  return booking;
}
