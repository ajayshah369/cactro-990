import { z } from "zod";
import { EventStatus } from "../generated/prisma/enums.js";

const maxDatabaseInteger = 2_147_483_647;
const dateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const eventFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10_000),
  venue: z.string().trim().min(1).max(300),
  startsAt: dateTime.refine((value) => value.getTime() > Date.now(), {
    message: "Event start time must be in the future",
  }),
  endsAt: dateTime,
  capacity: z.number().int().min(1).max(maxDatabaseInteger),
  ticketPrice: z.number().int().min(0).max(maxDatabaseInteger),
  currency: z.literal("INR"),
};

export const createEventSchema = z.strictObject({
  ...eventFields,
  currency: eventFields.currency.default("INR"),
}).refine((value) => value.endsAt > value.startsAt, {
  message: "Event end time must be after its start time",
  path: ["endsAt"],
});

export const updateEventSchema = z.strictObject(eventFields).partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: "Provide at least one event field to update",
  })
  .refine((value) => !value.startsAt || !value.endsAt || value.endsAt > value.startsAt, {
    message: "Event end time must be after its start time",
    path: ["endsAt"],
  });

export const eventParamsSchema = z.strictObject({ id: z.cuid() });

function positiveQueryInteger(max: number) {
  return z.string().regex(/^\d+$/, "Expected a positive whole number")
    .transform(Number).pipe(z.number().int().min(1).max(max));
}

const listFields = {
  page: positiveQueryInteger(10_000).default(1),
  limit: positiveQueryInteger(100).default(20),
  search: z.string().trim().min(1).max(100).optional(),
  venue: z.string().trim().min(1).max(300).optional(),
  from: dateTime.optional(),
  to: dateTime.optional(),
};

function validDateRange(value: { from?: Date; to?: Date }) {
  return !value.from || !value.to || value.from <= value.to;
}

export const browseEventsSchema = z.strictObject(listFields).refine(validDateRange, {
  message: "The 'to' date must be on or after the 'from' date",
  path: ["to"],
});

export const organizerEventsSchema = z.strictObject({
  ...listFields,
  status: z.enum(EventStatus).optional(),
}).refine(validDateRange, {
  message: "The 'to' date must be on or after the 'from' date",
  path: ["to"],
});

export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type EventParams = z.infer<typeof eventParamsSchema>;
export type BrowseEventsQuery = z.infer<typeof browseEventsSchema>;
export type OrganizerEventsQuery = z.infer<typeof organizerEventsSchema>;
