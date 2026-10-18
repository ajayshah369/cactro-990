import type { Request, RequestHandler } from "express";
import createHttpError from "http-errors";
import type { BookingParams, CreateBookingInput, ListBookingsQuery } from "../../schemas/booking.schema.js";
import * as bookingService from "../../services/booking.service.js";

function authenticatedUserId(req: Pick<Request, "user">): string {
  if (!req.user) throw createHttpError(401, "Authentication is required");
  return req.user.id;
}

export const create: RequestHandler<Record<string, never>, unknown, CreateBookingInput> = async (req, res) => {
  const { booking, created } = await bookingService.createBooking(authenticatedUserId(req), req.body);
  res.location(`/bookings/${booking.id}`).status(created ? 201 : 200).json({ success: true, data: booking });
};

export const listOwn: RequestHandler<Record<string, never>, unknown, unknown, unknown, {
  validatedQuery: ListBookingsQuery;
}> = async (req, res) => {
  const data = await bookingService.listCustomerBookings(authenticatedUserId(req), res.locals.validatedQuery);
  res.status(200).json({ success: true, data });
};

export const getOwnById: RequestHandler<BookingParams> = async (req, res) => {
  const booking = await bookingService.getCustomerBooking(req.params.id, authenticatedUserId(req));
  res.status(200).json({ success: true, data: booking });
};
