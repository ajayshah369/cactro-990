import { z } from "zod";

export const createBookingSchema = z.strictObject({
  eventId: z.cuid(),
  quantity: z.number().int().min(1).max(2_147_483_647),
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, {
    message: "Idempotency key must contain only letters, numbers, underscores or hyphens",
  }),
});

export const bookingParamsSchema = z.strictObject({ id: z.cuid() });

function positiveQueryInteger(max: number) {
  return z.string().regex(/^\d+$/, "Expected a positive whole number")
    .transform(Number).pipe(z.number().int().min(1).max(max));
}

export const listBookingsSchema = z.strictObject({
  page: positiveQueryInteger(10_000).default(1),
  limit: positiveQueryInteger(100).default(20),
  eventId: z.cuid().optional(),
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;
export type BookingParams = z.infer<typeof bookingParamsSchema>;
export type ListBookingsQuery = z.infer<typeof listBookingsSchema>;
