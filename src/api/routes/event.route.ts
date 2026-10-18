import { Router } from "express";
import * as eventController from "../controllers/event.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateBody } from "../../middlewares/validateBody.js";
import { validateParams } from "../../middlewares/validateParams.js";
import { validateQuery } from "../../middlewares/validateQuery.js";
import {
  browseEventsSchema,
  createEventSchema,
  eventParamsSchema,
  organizerEventsSchema,
  updateEventSchema,
} from "../../schemas/event.schema.js";

export const eventRouter = Router();
export const organizerEventRouter = Router();

eventRouter.get("/", validateQuery(browseEventsSchema), eventController.browse);
eventRouter.get("/:id", validateParams(eventParamsSchema), eventController.getById);

organizerEventRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
organizerEventRouter.use(authenticate, authorize("ORGANIZER"));
organizerEventRouter.get("/", validateQuery(organizerEventsSchema), eventController.listOwn);
organizerEventRouter.get("/:id", validateParams(eventParamsSchema), eventController.getOwnById);
organizerEventRouter.post("/", validateBody(createEventSchema), eventController.create);
organizerEventRouter.patch("/:id",
  validateParams(eventParamsSchema), validateBody(updateEventSchema), eventController.update);
organizerEventRouter.delete("/:id", validateParams(eventParamsSchema), eventController.cancel);
