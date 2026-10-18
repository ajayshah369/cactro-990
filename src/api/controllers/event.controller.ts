import type { Request, RequestHandler } from "express";
import createHttpError from "http-errors";
import type {
  BrowseEventsQuery,
  CreateEventInput,
  EventParams,
  OrganizerEventsQuery,
  UpdateEventInput,
} from "../../schemas/event.schema.js";
import * as eventService from "../../services/event.service.js";

function authenticatedUserId(req: Pick<Request, "user">): string {
  if (!req.user) throw createHttpError(401, "Authentication is required");
  return req.user.id;
}

export const create: RequestHandler<Record<string, never>, unknown, CreateEventInput> = async (req, res) => {
  const event = await eventService.createEvent(authenticatedUserId(req), req.body);
  res.status(201).json({ success: true, data: event });
};

export const browse: RequestHandler<Record<string, never>, unknown, unknown, unknown, {
  validatedQuery: BrowseEventsQuery;
}> = async (_req, res) => {
  const data = await eventService.browseEvents(res.locals.validatedQuery);
  res.status(200).json({ success: true, data });
};

export const getById: RequestHandler<EventParams> = async (req, res) => {
  const event = await eventService.getPublicEvent(req.params.id);
  res.status(200).json({ success: true, data: event });
};

export const listOwn: RequestHandler<Record<string, never>, unknown, unknown, unknown, {
  validatedQuery: OrganizerEventsQuery;
}> = async (req, res) => {
  const data = await eventService.listOrganizerEvents(authenticatedUserId(req), res.locals.validatedQuery);
  res.status(200).json({ success: true, data });
};

export const getOwnById: RequestHandler<EventParams> = async (req, res) => {
  const event = await eventService.getOrganizerEvent(req.params.id, authenticatedUserId(req));
  res.status(200).json({ success: true, data: event });
};

export const update: RequestHandler<EventParams, unknown, UpdateEventInput> = async (req, res) => {
  const event = await eventService.updateEvent(req.params.id, authenticatedUserId(req), req.body);
  res.status(200).json({ success: true, data: event });
};

export const cancel: RequestHandler<EventParams> = async (req, res) => {
  await eventService.cancelEvent(req.params.id, authenticatedUserId(req));
  res.sendStatus(204);
};
