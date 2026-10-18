import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import type { UserRole } from "../generated/prisma/enums.js";

export function authorize(...allowedRoles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) {
      throw createHttpError(401, "Authentication is required");
    }

    if (!allowedRoles.includes(req.user.role)) {
      throw createHttpError(403, "You do not have permission to perform this action");
    }

    next();
  };
}
