import createHttpError from "http-errors";
import { prisma } from "../database/database.js";
import { Prisma, type Event } from "../generated/prisma/client.js";
import { queueEventUpdate } from "../notifications/notification.queue.js";
import type {
  BrowseEventsQuery,
  CreateEventInput,
  OrganizerEventsQuery,
  UpdateEventInput,
} from "../schemas/event.schema.js";

export async function createEvent(organizerId: string, input: CreateEventInput) {
  return prisma.event.create({
    data: {
      ...input,
      organizerId,
      remainingTickets: input.capacity,
      status: "PUBLISHED",
    },
  });
}

function searchFilters(query: BrowseEventsQuery): Prisma.EventWhereInput {
  return {
    ...(query.search ? { title: { contains: query.search, mode: "insensitive" } } : {}),
    ...(query.venue ? { venue: { contains: query.venue, mode: "insensitive" } } : {}),
  };
}

async function paginateEvents(
  where: Prisma.EventWhereInput,
  query: BrowseEventsQuery,
  orderBy: Prisma.EventOrderByWithRelationInput[],
) {
  // Use one snapshot so the count and page agree during concurrent changes.
  const [events, total] = await prisma.$transaction([
    prisma.event.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.event.count({ where }),
  ], { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

  return {
    events,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export async function browseEvents(query: BrowseEventsQuery) {
  const now = new Date();
  return paginateEvents({
    ...searchFilters(query),
    status: "PUBLISHED",
    deletedAt: null,
    startsAt: {
      gt: now,
      ...(query.from ? { gte: query.from } : {}),
      ...(query.to ? { lte: query.to } : {}),
    },
  }, query, [{ startsAt: "asc" }, { id: "asc" }]);
}

export async function getPublicEvent(eventId: string) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, status: "PUBLISHED", deletedAt: null },
  });

  if (!event) throw createHttpError(404, "Event not found");
  return event;
}

export async function listOrganizerEvents(organizerId: string, query: OrganizerEventsQuery) {
  return paginateEvents({
    ...searchFilters(query),
    organizerId,
    ...(query.status ? { status: query.status } : {}),
    ...(query.from || query.to ? {
      startsAt: {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      },
    } : {}),
  }, query, [{ createdAt: "desc" }, { id: "desc" }]);
}

export async function getOrganizerEvent(eventId: string, organizerId: string) {
  const event = await prisma.event.findUnique({ where: { id: eventId } });

  if (!event) throw createHttpError(404, "Event not found");
  if (event.organizerId !== organizerId) {
    throw createHttpError(403, "You can only view your own events");
  }

  return event;
}

async function lockOwnedEvent(tx: Prisma.TransactionClient, eventId: string, organizerId: string) {
  // Parameterized SQL. Booking transactions lock this same row.
  const [event] = await tx.$queryRaw<Event[]>`
    SELECT * FROM "events" WHERE "id" = ${eventId} FOR UPDATE
  `;

  if (!event) throw createHttpError(404, "Event not found");
  if (event.organizerId !== organizerId) {
    throw createHttpError(403, "You can only manage your own events");
  }

  return event;
}

export async function updateEvent(eventId: string, organizerId: string, input: UpdateEventInput) {
  return prisma.$transaction(async (tx) => {
    const event = await lockOwnedEvent(tx, eventId, organizerId);

    if (event.status === "CANCELLED" || event.deletedAt) {
      throw createHttpError(409, "Cancelled events cannot be updated");
    }

    const startsAt = input.startsAt ?? event.startsAt;
    const endsAt = input.endsAt ?? event.endsAt;
    if (endsAt <= startsAt) {
      throw createHttpError(400, "Event end time must be after its start time");
    }

    const soldTickets = event.capacity - event.remainingTickets;
    const capacity = input.capacity ?? event.capacity;
    if (capacity < soldTickets) {
      throw createHttpError(409, "Capacity cannot be lower than the number of tickets already sold");
    }

    const changed = Object.entries(input).some(([key, value]) => {
      const previous = event[key as keyof UpdateEventInput];
      return value instanceof Date && previous instanceof Date
        ? value.getTime() !== previous.getTime()
        : value !== previous;
    });
    if (!changed) return event;

    const updated = await tx.event.update({
      where: { id: eventId },
      data: {
        ...input,
        // Preserve sold tickets when capacity changes; never reset inventory.
        ...(input.capacity !== undefined ? { remainingTickets: capacity - soldTickets } : {}),
      },
    });
    await queueEventUpdate(tx, updated);
    return updated;
  });
}

export async function cancelEvent(eventId: string, organizerId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const event = await lockOwnedEvent(tx, eventId, organizerId);
    if (event.deletedAt) return;

    const cancelled = await tx.event.update({
      where: { id: eventId },
      data: { status: "CANCELLED", deletedAt: new Date() },
    });
    await queueEventUpdate(tx, cancelled);
  });
}
