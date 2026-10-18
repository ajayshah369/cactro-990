import type { CookieOptions, Response } from "express";
import { env } from "../config/env.js";

export const AUTH_COOKIE_NAME = "access_token";

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  };
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...cookieOptions(),
    // Express expects milliseconds; the JWT lifetime is configured in seconds.
    maxAge: env.JWT_ACCESS_TOKEN_TTL_SECONDS * 1000,
  });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, cookieOptions());
}
