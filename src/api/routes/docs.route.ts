import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiDocument } from "../../docs/openapi.js";

export const docsRouter = Router();

docsRouter.get("/api-docs.json", (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(openApiDocument);
});

docsRouter.use("/api-docs", swaggerUi.serve, swaggerUi.setup(undefined, {
  customSiteTitle: "Event Booking API Docs",
  swaggerOptions: {
    url: "/api-docs.json",
    withCredentials: true,
    validatorUrl: null,
    displayRequestDuration: true,
    docExpansion: "list",
  },
}));
