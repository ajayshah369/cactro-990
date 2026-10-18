# Authentication

The request flow is:

`auth.route.ts -> rate limiter -> validateBody(Zod schema) -> controller -> auth service -> Prisma`

- `src/schemas/auth.schema.ts` validates requests, normalizes email, and supplies the default `CUSTOMER` role. Passwords are preserved exactly as entered. Registration requires 12–128 characters.
- `src/api/routes/auth.route.ts` connects endpoints to middleware and controllers.
- `src/api/controllers/auth.controller.ts` reads validated input, sets or clears the auth cookie, and returns HTTP responses.
- `src/services/auth.service.ts` hashes/verifies passwords, accesses users, handles duplicate emails, and creates authentication results.
- `src/utils/jwt.ts` signs and verifies access tokens, including their algorithm, expiry, issuer, audience, and role.
- `src/utils/authCookie.ts` sets and clears the `access_token` cookie with matching options.
- `src/middlewares/authenticate.ts` reads the JWT from that cookie and loads the active user into `req.user`.
- `src/middlewares/authorize.ts` checks the user's current database role. Use it after `authenticate` on future event routes.
- `src/middlewares/verifyRequestOrigin.ts` rejects untrusted browser origins on requests that change data. It runs globally before the routes, including login and logout.

## Configuration

The existing database settings and two auth settings are read from `.env`:

```dotenv
JWT_SECRET=<a randomly generated secret with at least 32 characters>
JWT_ACCESS_TOKEN_TTL_SECONDS=900
```

The local secret has been generated in the ignored `.env` file. Set a separate random secret in the deployment environment. All API instances for one environment must use the same secret. Changing it invalidates existing tokens.

Set `BE_URL` to the public API URL. Its origin is the trusted browser origin for POST, PUT, PATCH, DELETE, and other unsafe methods. The current browser setup assumes the frontend and API share an origin. A separate frontend will require an explicit trusted-origin/CORS configuration before it can send credentialed requests. curl and Postman can make requests without browser origin headers.

## Try the API

Start with `npm run dev`. The examples assume `PORT=3000`; use the port configured in your `.env`.

Register a customer:

```bash
curl -c /tmp/cactro-auth.cookies http://localhost:3000/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Demo Customer","email":"customer@example.com","password":"Demo-passphrase-123!","role":"CUSTOMER"}'
```

Register an organizer by using a different email and `"role":"ORGANIZER"`. Public role selection is intentional for this assignment. Omitting `role` creates a customer; other roles and unexpected request fields are rejected.

Log in:

```bash
curl -c /tmp/cactro-auth.cookies http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"customer@example.com","password":"Demo-passphrase-123!"}'
```

Registration returns `201`; login returns `200`. Both set an HTTP-only cookie containing the JWT. The response body contains no token:

```json
{
  "success": true,
  "data": {
    "user": {
      "id": "<cuid>",
      "name": "Demo Customer",
      "email": "customer@example.com",
      "role": "CUSTOMER",
      "createdAt": "<timestamp>"
    },
    "expiresIn": 900
  }
}
```

Send the saved cookie to fetch your profile:

```bash
curl -b /tmp/cactro-auth.cookies http://localhost:3000/auth/me
```

Log out by clearing the cookie:

```bash
curl -X POST -b /tmp/cactro-auth.cookies -c /tmp/cactro-auth.cookies \
  http://localhost:3000/auth/logout
```

Logout returns `204`, even when there is no valid session. It clears the browser cookie; a separately copied JWT remains valid until expiry unless the user is deleted. There is no server-side token revocation store yet.

## Cookie and JWT

The `access_token` cookie has `HttpOnly`, `SameSite=Lax`, `Path=/`, and a lifetime equal to the JWT lifetime (15 minutes by default). It has no `Domain` attribute, so it belongs to the API host. Production adds `Secure` and requires HTTPS; local development permits HTTP.

The signed JWT payload contains:

```json
{
  "sub": "<user ID>",
  "role": "CUSTOMER",
  "iss": "cactro-990",
  "aud": "cactro-990-api",
  "iat": 1700000000,
  "exp": 1700000900
}
```

`role` is either `CUSTOMER` or `ORGANIZER` and is checked during token verification. It reflects the role when the token was issued. Authorization still uses the current database role so permission changes take effect immediately. Tokens issued before this change lack the role claim and require a fresh login.

In a browser, the cookie is sent automatically for same-origin requests. You can use `fetch('/auth/me', { credentials: 'include' })`; JavaScript cannot read the HTTP-only cookie. Get the displayed role from the response's `data.user.role`. No Authorization header or localStorage token is needed. Keep the curl cookie jar private because it contains an active credential.

## Expected behavior

| Scenario | Status |
| --- | --- |
| Invalid registration or login fields | `400` |
| Wrong email/password, missing or invalid token | `401` |
| Authenticated user without the required role | `403` |
| Untrusted browser origin on a request that changes data | `403` |
| Email already registered, including a soft-deleted account | `409` |
| Too many registration/login attempts from one IP | `429` |

Passwords use Argon2id with a random salt. Password hashes never appear in API responses. Unknown emails and wrong passwords receive the same error, and both perform hash verification. JWTs carry a user ID and role; protected requests reload the active user so soft deletion and role changes apply immediately.

Login allows 10 failed attempts per IP in 15 minutes; registration allows 20 attempts. The current rate limiter uses process-local memory. Before deploying multiple API instances, use a shared store and configure Express's trusted proxy setting for the actual hosting topology. Successful logins do not consume the failed-login allowance.

There are no refresh tokens, server-side token revocation, email verification, or password reset in this increment. Log in again when the access token expires.

## Verify

```bash
npm run check
npm run test:auth
```

The integration tests require the configured PostgreSQL database and its existing migration. They start an HTTP server on a random local port, create users with unique `@example.test` addresses, and remove only those test users when finished. They do not send emails.
