import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import type { ZodType } from "zod";

export function validateQuery(schema: ZodType): RequestHandler {
  return (req, res, next) => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      next(createHttpError(400, result.error.issues[0]?.message ?? "Invalid query parameters"));
      return;
    }

    // Express 5 exposes req.query as a getter; keep parsed values in locals.
    res.locals.validatedQuery = result.data;
    next();
  };
}
