import type { ErrorRequestHandler } from "express";
import createHttpError from "http-errors";

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  req,
  res,
  next,
) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const httpError = createHttpError.isHttpError(error)
    ? error
    : createHttpError(500, "Internal server error");

  if (httpError.statusCode >= 500) {
    console.error("Request failed:", {
      method: req.method,
      path: req.path,
      error,
    });
  }

  res.status(httpError.statusCode).json({
    success: false,
    message: httpError.expose ? httpError.message : "Internal server error",
  });
};
