import type { Booking, Event, Prisma } from "../generated/prisma/client.js";

function eventDetails(event: Event): string {
  return `Event: ${event.title}\nVenue: ${event.venue}\nStarts: ${event.startsAt.toISOString()}\nEnds: ${event.endsAt.toISOString()}\nStatus: ${event.status}`;
}

export async function queueBookingConfirmation(tx: Prisma.TransactionClient, booking: Booking, event: Event) {
  const customer = await tx.user.findUniqueOrThrow({
    where: { id: booking.customerId }, select: { id: true, name: true, email: true },
  });
  await tx.notificationJob.create({
    data: {
      type: "BOOKING_CONFIRMATION", eventId: event.id, customerId: customer.id, bookingId: booking.id,
      payload: {
        to: customer.email, subject: `Booking confirmed: ${event.title}`,
        text: `Hello ${customer.name},\nYour booking ${booking.id} is confirmed.\nTickets: ${booking.quantity}\nTotal: ${booking.currency} ${(booking.totalAmount / 100).toFixed(2)}\n${eventDetails(event)}`,
      },
    },
  });
}

export async function queueEventUpdate(tx: Prisma.TransactionClient, event: Event) {
  // Query users with at least one booking: several bookings still yield one recipient.
  // The caller holds the event lock, so the recipients match this update exactly.
  const customers = await tx.user.findMany({
    where: { deletedAt: null, bookings: { some: { eventId: event.id, deletedAt: null } } },
    select: { id: true, name: true, email: true },
  });
  if (customers.length === 0) return;

  await tx.notificationJob.createMany({
    data: customers.map((customer) => ({
      type: "EVENT_UPDATED", eventId: event.id, customerId: customer.id,
      payload: {
        to: customer.email,
        subject: `${event.status === "CANCELLED" ? "Event cancelled" : "Event updated"}: ${event.title}`,
        text: `Hello ${customer.name},\nAn event you booked has changed.\n${eventDetails(event)}\nDescription: ${event.description}\nCapacity: ${event.capacity}\nCurrent ticket price: ${event.currency} ${(event.ticketPrice / 100).toFixed(2)}\nYour original booking price is unchanged.`,
      },
    })),
  });
}
