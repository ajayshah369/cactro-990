import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import cookieParser from "cookie-parser";
import { jwtVerify, SignJWT } from "jose";
import { verify } from "argon2";
import { app } from "../src/server.js";
import { prisma } from "../src/database/database.js";
import { env } from "../src/config/env.js";
import { authenticate } from "../src/middlewares/authenticate.js";
import { authorize } from "../src/middlewares/authorize.js";
import { errorHandler } from "../src/middlewares/errorHandler.js";
import { AUTH_COOKIE_NAME } from "../src/utils/authCookie.js";

// Uses the configured PostgreSQL database and removes only this run's test users.
test("authentication API", async (t) => {
  const runId = randomUUID();
  const customerEmail = `auth-customer-${runId}@example.test`;
  const organizerEmail = `auth-organizer-${runId}@example.test`;
  const raceEmail = `auth-race-${runId}@example.test`;
  const emails = [customerEmail, organizerEmail, raceEmail];
  const password = " A test passphrase 123! ";
  let customerId = "";
  let customerToken = "";
  let organizerToken = "";

  // Exercise the reusable role guard without adding test endpoints to the API.
  const testApp = express();
  testApp.use(cookieParser());
  testApp.get("/organizer-only", authenticate, authorize("ORGANIZER"), (_req, res) => {
    res.json({ success: true });
  });
  testApp.use(app);
  testApp.use(errorHandler);
  const server = testApp.listen(0, "127.0.0.1");

  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    try {
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  await once(server, "listening");
  await prisma.$queryRaw`SELECT 1`;
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function request(path: string, body?: unknown, token?: string) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(token ? { Cookie: `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  }

  function tokenFromCookie(headers: Headers): string {
    const cookie = headers.getSetCookie().find((value) => value.startsWith(`${AUTH_COOKIE_NAME}=`));
    assert.ok(cookie);
    assert.ok(cookie.includes("; HttpOnly"));
    assert.ok(cookie.includes("; SameSite=Lax"));
    assert.ok(cookie.includes("; Path=/"));
    assert.ok(cookie.includes(`; Max-Age=${env.JWT_ACCESS_TOKEN_TTL_SECONDS}`));
    assert.equal(cookie.includes("; Secure"), env.NODE_ENV === "production");
    assert.equal(cookie.includes("; Domain="), false);
    return decodeURIComponent(cookie.split(";")[0]!.slice(AUTH_COOKIE_NAME.length + 1));
  }

  await t.test("registration rejects invalid input and unexpected fields", async () => {
    const input = { name: "Customer", email: customerEmail, password };
    for (const invalid of [
      { ...input, name: " " },
      { ...input, email: "not-an-email" },
      { ...input, password: "short" },
      { ...input, role: "ADMIN" },
      { ...input, passwordHash: "injected" },
    ]) {
      assert.equal((await request("/auth/register", invalid)).status, 400);
    }
    assert.equal(await prisma.user.count({ where: { email: customerEmail } }), 0);
  });

  await t.test("registration normalizes email and defaults to CUSTOMER", async () => {
    const result = await request("/auth/register", {
      name: " Customer ", email: ` ${customerEmail.toUpperCase()} `, password,
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.name, "Customer");
    assert.equal(result.body.data.email, customerEmail);
    assert.equal(result.body.data.role, "CUSTOMER");
    assert.equal("accessToken" in result.body.data, false);
    assert.equal("tokenType" in result.body.data, false);
    assert.equal("passwordHash" in result.body.data, false);
    assert.equal(result.headers.get("cache-control"), "no-store");
    customerId = result.body.data.id;
    customerToken = tokenFromCookie(result.headers);
    const { payload } = await jwtVerify(customerToken, new TextEncoder().encode(env.JWT_SECRET));
    assert.equal(payload.sub, customerId);
    assert.equal(payload.role, "CUSTOMER");
    assert.equal(payload.exp! - payload.iat!, env.JWT_ACCESS_TOKEN_TTL_SECONDS);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: customerId } });
    assert.ok(stored.passwordHash.startsWith("$argon2id$"));
    assert.equal(await verify(stored.passwordHash, password), true);
  });

  await t.test("ORGANIZER registration is supported", async () => {
    const result = await request("/auth/register", {
      name: "Organizer", email: organizerEmail, password, role: "ORGANIZER",
    });
    assert.equal(result.status, 201);
    assert.equal(result.body.data.role, "ORGANIZER");
    organizerToken = tokenFromCookie(result.headers);
    const { payload } = await jwtVerify(organizerToken, new TextEncoder().encode(env.JWT_SECRET));
    assert.equal(payload.role, "ORGANIZER");
  });

  await t.test("duplicate normalized emails return 409", async () => {
    const result = await request("/auth/register", {
      name: "Duplicate", email: customerEmail.toUpperCase(), password,
    });
    assert.equal(result.status, 409);
    assert.equal(await prisma.user.count({ where: { email: customerEmail } }), 1);
  });

  await t.test("simultaneous registrations produce one account", async () => {
    const input = { name: "Race", email: raceEmail, password };
    const results = await Promise.all([
      request("/auth/register", input), request("/auth/register", input),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
    assert.equal(await prisma.user.count({ where: { email: raceEmail } }), 1);
  });

  await t.test("login normalizes email and sets a usable HTTP-only cookie", async () => {
    const result = await request("/auth/login", { email: ` ${customerEmail.toUpperCase()} `, password });
    assert.equal(result.status, 200);
    assert.equal("passwordHash" in result.body.data, false);
    assert.equal("accessToken" in result.body.data, false);
    customerToken = tokenFromCookie(result.headers);
    const profile = await request("/auth/me", undefined, customerToken);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.id, customerId);
    assert.equal("passwordHash" in profile.body.data, false);
  });

  await t.test("production cookies have the Secure attribute", async () => {
    const originalEnvironment = env.NODE_ENV;
    try {
      env.NODE_ENV = "production";
      const result = await request("/auth/login", { email: organizerEmail, password });
      assert.equal(result.status, 200);
      tokenFromCookie(result.headers);
    } finally {
      env.NODE_ENV = originalEnvironment;
    }
  });

  await t.test("a Bearer header alone no longer authenticates", async () => {
    const result = await fetch(`${baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.equal(result.status, 401);
    await result.arrayBuffer();
  });

  await t.test("unknown email and wrong password give the same response", async () => {
    const unknown = await request("/auth/login", { email: `missing-${runId}@example.test`, password });
    const wrong = await request("/auth/login", { email: customerEmail, password: "Wrong passphrase 123!" });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(unknown.body, wrong.body);
  });

  await t.test("password whitespace is significant", async () => {
    assert.equal((await request("/auth/login", { email: customerEmail, password: password.trim() })).status, 401);
  });

  await t.test("missing, malformed and tampered tokens return 401", async () => {
    assert.equal((await request("/auth/me")).status, 401);
    assert.equal((await request("/auth/me", undefined, "not-a-jwt")).status, 401);
    const parts = customerToken.split(".");
    parts[2] = (parts[2]!.startsWith("A") ? "B" : "A") + parts[2]!.slice(1);
    assert.equal((await request("/auth/me", undefined, parts.join("."))).status, 401);
  });

  await t.test("expired, wrong issuer, wrong audience and incomplete tokens return 401", async () => {
    const key = new TextEncoder().encode(env.JWT_SECRET);
    for (const kind of ["expired", "issuer", "audience", "expiry", "signature", "algorithm", "role", "missingRole"]) {
      let jwt = new SignJWT(kind === "missingRole" ? {} : { role: kind === "role" ? "ADMIN" : "CUSTOMER" })
        .setProtectedHeader({ alg: kind === "algorithm" ? "HS512" : "HS256" })
        .setSubject(customerId)
        .setIssuer(kind === "issuer" ? "another-app" : "cactro-990")
        .setAudience(kind === "audience" ? "another-api" : "cactro-990-api")
        .setIssuedAt();
      if (kind !== "expiry") jwt = jwt.setExpirationTime(kind === "expired" ? Math.floor(Date.now() / 1000) - 60 : "15m");
      const token = await jwt.sign(kind === "signature" ? randomBytes(32) : key);
      assert.equal((await request("/auth/me", undefined, token)).status, 401, kind);
    }
  });

  await t.test("role guard permits organizers and denies customers", async () => {
    assert.equal((await request("/organizer-only")).status, 401);
    assert.equal((await request("/organizer-only", undefined, customerToken)).status, 403);
    assert.equal((await request("/organizer-only", undefined, organizerToken)).status, 200);
  });

  await t.test("role changes take effect without issuing another token", async () => {
    // The role claim is a snapshot; authorization still uses the live database role.
    const { payload } = await jwtVerify(customerToken, new TextEncoder().encode(env.JWT_SECRET));
    assert.equal(payload.role, "CUSTOMER");
    await prisma.user.update({ where: { id: customerId }, data: { role: "ORGANIZER" } });
    assert.equal((await request("/organizer-only", undefined, customerToken)).status, 200);
    await prisma.user.update({ where: { id: customerId }, data: { role: "CUSTOMER" } });
    assert.equal((await request("/organizer-only", undefined, customerToken)).status, 403);
  });

  await t.test("untrusted browser origins cannot change authentication cookies", async () => {
    for (const endpoint of ["/auth/register", "/auth/login", "/auth/logout"]) {
      for (const origin of ["https://untrusted.example", "null"]) {
        const result = await fetch(`${baseUrl}${endpoint}`, {
          method: "POST",
          headers: { Origin: origin, Cookie: `${AUTH_COOKIE_NAME}=${customerToken}` },
        });
        assert.equal(result.status, 403);
        assert.equal(result.headers.has("set-cookie"), false);
        await result.arrayBuffer();
      }
    }
    for (const fetchSite of ["cross-site", "same-site"]) {
      const result = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST", headers: { "Sec-Fetch-Site": fetchSite },
      });
      assert.equal(result.status, 403);
      await result.arrayBuffer();
    }
    const result = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST", headers: { Referer: "https://untrusted.example/form" },
    });
    assert.equal(result.status, 403);
    await result.arrayBuffer();
  });

  await t.test("trusted-origin logout expires the cookie and works without a session", async () => {
    for (const token of [customerToken, ""]) {
      const result = await fetch(`${baseUrl}/auth/logout`, {
        method: "POST",
        headers: {
          Origin: new URL(env.BE_URL).origin,
          ...(token ? { Cookie: `${AUTH_COOKIE_NAME}=${token}` } : {}),
        },
      });
      assert.equal(result.status, 204);
      const cookie = result.headers.getSetCookie().find((value) => value.startsWith(`${AUTH_COOKIE_NAME}=`));
      assert.ok(cookie?.startsWith(`${AUTH_COOKIE_NAME}=;`));
      assert.ok(cookie.includes("; HttpOnly"));
      assert.ok(cookie.includes("; SameSite=Lax"));
      assert.ok(cookie.includes("; Path=/"));
      const expires = cookie.match(/Expires=([^;]+)/)?.[1];
      assert.ok(expires);
      assert.ok(Date.parse(expires) < Date.now());
      assert.equal(result.headers.get("cache-control"), "no-store");
    }
    assert.equal((await request("/auth/me")).status, 401);
  });

  await t.test("soft deletion blocks login and previously issued tokens", async () => {
    await prisma.user.update({ where: { id: customerId }, data: { deletedAt: new Date() } });
    assert.equal((await request("/auth/login", { email: customerEmail, password })).status, 401);
    assert.equal((await request("/auth/me", undefined, customerToken)).status, 401);
    assert.equal((await request("/auth/register", { name: "Deleted", email: customerEmail, password })).status, 409);
  });

  await t.test("login rejects invalid input", async () => {
    assert.equal((await request("/auth/login", { email: customerEmail, password: "" })).status, 400);
  });

  await t.test("malformed JSON returns 400", async () => {
    const result = await fetch(`${baseUrl}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{",
    });
    assert.equal(result.status, 400);
    await result.arrayBuffer();
  });

  await t.test("repeated failed logins are rate limited", async () => {
    let limited = false;
    for (let attempt = 0; attempt < 11; attempt++) {
      const result = await request("/auth/login", { email: customerEmail, password: "" });
      if (result.status === 429) {
        assert.equal(result.body.success, false);
        assert.ok(result.headers.has("retry-after"));
        limited = true;
        break;
      }
    }
    assert.equal(limited, true);
  });
});
