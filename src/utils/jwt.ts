import createHttpError from "http-errors";
import { errors, jwtVerify, SignJWT } from "jose";
import { env } from "../config/env.js";
import { UserRole } from "../generated/prisma/enums.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);
const issuer = "cactro-990";
const audience = "cactro-990-api";

export type AccessTokenPayload = { userId: string; role: UserRole };

export async function createAccessToken(userId: string, role: UserRole): Promise<string> {
  return new SignJWT({ role })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + env.JWT_ACCESS_TOKEN_TTL_SECONDS)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
      issuer,
      audience,
      requiredClaims: ["sub", "role", "iat", "exp"],
      maxTokenAge: env.JWT_ACCESS_TOKEN_TTL_SECONDS,
    });

    if (!payload.sub || (payload.role !== UserRole.CUSTOMER && payload.role !== UserRole.ORGANIZER)) {
      throw createHttpError(401, "Invalid or expired access token");
    }

    return { userId: payload.sub, role: payload.role };
  } catch (error) {
    if (error instanceof errors.JOSEError) {
      throw createHttpError(401, "Invalid or expired access token");
    }

    throw error;
  }
}
