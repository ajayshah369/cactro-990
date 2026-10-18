import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import type { ZodType } from "zod";

export function validateParams(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req.params);

    if (!result.success) {
      next(createHttpError(400, result.error.issues[0]?.message ?? "Invalid route parameters"));
      return;
    }

    next();
  };
}
