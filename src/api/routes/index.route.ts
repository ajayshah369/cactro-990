import { Router } from "express";
import authRouter from "./auth.route.js";
import { eventRouter, organizerEventRouter } from "./event.route.js";
import { bookingRouter } from "./booking.route.js";

const router = Router();

router.use("/auth", authRouter);
router.use("/events", eventRouter);
router.use("/organizer/events", organizerEventRouter);
router.use("/bookings", bookingRouter);

export default router;
