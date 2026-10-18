import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import { getAuthenticatedUser } from "../services/auth.service.js";
import { AUTH_COOKIE_NAME } from "../utils/authCookie.js";

export const authenticate: RequestHandler = async (req, _res, next) => {
  const token: unknown = req.cookies?.[AUTH_COOKIE_NAME];

  if (typeof token !== "string" || !token) {
    throw createHttpError(401, "An authentication cookie is required");
  }

  req.user = await getAuthenticatedUser(token);
  next();
};
