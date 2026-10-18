import express from "express";
import cookieParser from "cookie-parser";
import createHttpError from "http-errors";
import morgan from "morgan";
import { errorHandler } from "./middlewares/errorHandler.js";
import router from "./api/routes/index.route.js";
import { verifyRequestOrigin } from "./middlewares/verifyRequestOrigin.js";

export const app = express();

// 1. Log requests, including their final status and response time.
app.use(morgan(":method :url :status :response-time ms"));

// 2. Parse cookies and check browser origins before accepting writes.
app.use(cookieParser());
app.use(verifyRequestOrigin);
app.use(express.json());

// 3. Register routes.
app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    message: "Server is running",
  });
});

// Register your API routes here.
app.use(router);

// 4. Handle requests that did not match any route.
app.use((_req, _res, next) => {
  next(createHttpError(404, "Route not found"));
});

// 5. Global error handler — always register last.
app.use(errorHandler);
