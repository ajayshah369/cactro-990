import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import SwaggerParser from "@apidevtools/swagger-parser";
import { app } from "../src/server.js";
import { openApiDocument } from "../src/docs/openapi.js";
import { loginSchema, registerSchema } from "../src/schemas/auth.schema.js";
import { createEventSchema, updateEventSchema } from "../src/schemas/event.schema.js";
import { createBookingSchema } from "../src/schemas/booking.schema.js";

test("Swagger documentation", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const specResponse = await fetch(`${baseUrl}/api-docs.json`);
  const spec = await specResponse.json();

  await t.test("the served OpenAPI document validates with all references resolved", async () => {
    assert.equal(specResponse.status, 200);
    assert.match(specResponse.headers.get("content-type")!, /application\/json/);
    assert.deepEqual(spec, openApiDocument);
    await SwaggerParser.validate(structuredClone(spec));
    assert.equal(spec.openapi, "3.0.3");
    assert.deepEqual(spec.servers, [{ url: "/", description: "This API server" }]);
  });

  await t.test("all 15 current operations have unique operation IDs and correct cookie security", () => {
    const expected = [
      ["get", "/health", false],
      ["post", "/auth/register", false], ["post", "/auth/login", false],
      ["post", "/auth/logout", false], ["get", "/auth/me", true],
      ["get", "/events", false], ["get", "/events/{id}", false],
      ["get", "/organizer/events", true], ["post", "/organizer/events", true],
      ["get", "/organizer/events/{id}", true], ["patch", "/organizer/events/{id}", true],
      ["delete", "/organizer/events/{id}", true],
      ["get", "/bookings", true], ["post", "/bookings", true], ["get", "/bookings/{id}", true],
    ] as const;
    const ids = new Set<string>();
    for (const [method, path, protectedRoute] of expected) {
      const operation = spec.paths[path][method];
      assert.ok(operation.operationId);
      ids.add(operation.operationId);
      assert.deepEqual(operation.security ?? [], protectedRoute ? [{ cookieAuth: [] }] : []);
    }
    assert.equal(ids.size, 15);
    assert.equal(spec.components.securitySchemes.cookieAuth.type, "apiKey");
    assert.equal(spec.components.securitySchemes.cookieAuth.in, "cookie");
    assert.equal(spec.components.securitySchemes.cookieAuth.name, "access_token");
  });

  await t.test("documented request examples pass the application's real validators", () => {
    for (const [path, method, schema] of [
      ["/auth/register", "post", registerSchema], ["/auth/login", "post", loginSchema],
      ["/organizer/events", "post", createEventSchema],
      ["/organizer/events/{id}", "patch", updateEventSchema], ["/bookings", "post", createBookingSchema],
    ] as const) {
      const example = spec.paths[path][method].requestBody.content["application/json"].example;
      assert.equal(schema.safeParse(example).success, true, `${method} ${path}`);
    }
    assert.equal(spec.components.schemas.UpdateEventInput.minProperties, 1);
    assert.equal(spec.components.schemas.RegisterInput.properties.email.format, "email");
    const parameters = spec.paths["/events"].get.parameters;
    assert.deepEqual(parameters.find((parameter: { name: string }) => parameter.name === "limit").schema, {
      default: 20, type: "integer", minimum: 1, maximum: 100,
    });
  });

  await t.test("Swagger HTML, initialization script and static assets are served locally", async () => {
    const html = await fetch(`${baseUrl}/api-docs`);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Event Booking API Docs/);
    const init = await fetch(`${baseUrl}/api-docs/swagger-ui-init.js`);
    assert.equal(init.status, 200);
    const script = await init.text();
    assert.match(script, /"url": "\/api-docs.json"/);
    assert.match(script, /"withCredentials": true/);
    assert.match(script, /"validatorUrl": null/);
    const css = await fetch(`${baseUrl}/api-docs/swagger-ui.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type")!, /text\/css/);
    await css.arrayBuffer();
  });

  await t.test("documentation mounting preserves health, authentication and 404 behavior", async () => {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", message: "Server is running" });
    for (const path of ["/auth/me", "/organizer/events", "/bookings"]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 401);
      await response.arrayBuffer();
    }
    const missing = await fetch(`${baseUrl}/not-a-route`);
    assert.equal(missing.status, 404);
    await missing.arrayBuffer();
  });
});
