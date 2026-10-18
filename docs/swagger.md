# Swagger API documentation

Start the application with `npm run dev`, then open:

- Swagger UI: `http://localhost:8000/api-docs`
- OpenAPI JSON: `http://localhost:8000/api-docs.json`

Use your configured port if it differs from `8000`. The same paths work on the deployed server. The specification uses a relative server URL so requests go to the server hosting the documentation.

## Use authenticated endpoints

1. Expand `POST /auth/login` under Authentication, click **Try it out**, enter your credentials, and click **Execute**. For a new account, use `POST /auth/register` and choose `CUSTOMER` or `ORGANIZER`.
2. The browser stores the HTTP-only `access_token` cookie. Execute `GET /auth/me` to verify the account and role.
3. Use the organizer endpoints to manage your events, or the customer endpoints to book and view tickets. The browser includes the cookie automatically.
4. Execute `POST /auth/logout` before switching accounts. Signing into another account also replaces the cookie.

Use the login endpoint for authentication; manually entering a cookie in Swagger's **Authorize** dialog does not set an HTTP-only cookie. Swagger-generated curl commands may omit browser-managed cookies, so use the cookie-jar examples in [auth.md](auth.md) when copying requests to a terminal.

Open the UI on the origin configured in `BE_URL`. For example, `http://localhost:8000` and `http://127.0.0.1:8000` are different origins. The existing origin checks still protect writes from Swagger. When deploying, set `BE_URL` to the deployed HTTPS origin; production authentication cookies have the `Secure` flag.

## Coverage

The document describes all 15 current API operations: health, registration, login, logout, current user, public browsing/details, organizer listing/details/create/update/cancel, and customer booking creation/list/details. It includes request examples, response schemas, query parameters, role requirements, and expected error statuses. `POST /bookings` documents both `201` creation and `200` idempotent replay.

For booking examples, replace the sample event ID with an actual event ID from `GET /events`. Reuse a key for retries of one purchase; use a new key for a new purchase. The event creation example generates future dates when the server starts. If the server has been running more than a week, enter future dates before executing that example.

Run `npm run worker:dev` in a second terminal to see simulated booking confirmations and event update notifications while trying these APIs. Jobs stay in PostgreSQL when the worker is stopped. See [notifications.md](notifications.md) for the complete flow.

## How it is maintained

- `src/docs/openapi.ts` defines the OpenAPI 3.0.3 document. Request schemas come from the existing Zod validators through `z.toJSONSchema`, using its OpenAPI target. Input mode preserves strings before date transformations. Pagination uses output mode to expose integer bounds and defaults. Descriptions cover rules that JSON Schema cannot express, such as future dates and ownership. Response schemas describe the JSON actually returned by controllers.
- `src/api/routes/docs.route.ts` serves the document and Swagger UI. Swagger's assets are served locally, and the external online validator is disabled. The UI uses browser-managed credentials.
- `src/server.ts` mounts these routes before the application's 404 handler.

When adding an endpoint, add its operation and response schema to the document. Body constraint changes flow from Zod automatically; review transformation rules, descriptions, examples, and response schemas when behavior changes.

Run `npm run test:docs` to validate the specification, resolve its references, check request examples against Zod, and verify that the documentation is served correctly. This test uses a local HTTP port and does not create database records. Run `npm run build` for lint, typecheck, and compilation.

References: [Swagger UI Express](https://github.com/scottie1984/swagger-ui-express), [Swagger UI credentials configuration](https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/), and [Zod JSON Schema generation](https://zod.dev/json-schema).
