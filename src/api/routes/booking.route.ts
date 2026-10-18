import { Router } from "express";
import * as bookingController from "../controllers/booking.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { authorize } from "../../middlewares/authorize.js";
import { validateBody } from "../../middlewares/validateBody.js";
import { validateParams } from "../../middlewares/validateParams.js";
import { validateQuery } from "../../middlewares/validateQuery.js";
import { bookingParamsSchema, createBookingSchema, listBookingsSchema } from "../../schemas/booking.schema.js";

export const bookingRouter = Router();

bookingRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
bookingRouter.use(authenticate, authorize("CUSTOMER"));
bookingRouter.post("/", validateBody(createBookingSchema), bookingController.create);
bookingRouter.get("/", validateQuery(listBookingsSchema), bookingController.listOwn);
bookingRouter.get("/:id", validateParams(bookingParamsSchema), bookingController.getOwnById);
