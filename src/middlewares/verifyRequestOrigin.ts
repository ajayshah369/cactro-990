import type { RequestHandler } from "express";
import createHttpError from "http-errors";
import { env } from "../config/env.js";

const trustedOrigin = new URL(env.BE_URL).origin;
const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);

// Cookie authentication needs CSRF protection, including on login and logout.
export const verifyRequestOrigin: RequestHandler = (req, _res, next) => {
  if (safeMethods.has(req.method)) {
    next();
    return;
  }

  const source = req.get("origin") ?? req.get("referer");
  const fetchSite = req.get("sec-fetch-site");

  if (source) {
    let sourceOrigin: string;
    try {
      sourceOrigin = new URL(source).origin;
    } catch {
      throw createHttpError(403, "Request origin is not allowed");
    }

    if (sourceOrigin !== trustedOrigin) {
      throw createHttpError(403, "Request origin is not allowed");
    }
  } else if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw createHttpError(403, "Request origin is not allowed");
  }

  // CLI/API clients such as curl and Postman may omit browser origin headers.
  next();
};
