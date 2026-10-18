import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import type { ZodType } from "zod";

export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(
        createHttpError(
          400,
          result.error.issues[0]?.message ?? "Invalid request body",
        ),
      );
      return;
    }

    req.body = result.data;
    next();
  };
}
