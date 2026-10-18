import { Router } from "express";
import { login, logout, me, register } from "../controllers/auth.controller.js";
import { authenticate } from "../../middlewares/authenticate.js";
import { loginRateLimit, registerRateLimit } from "../../middlewares/authRateLimit.js";
import { validateBody } from "../../middlewares/validateBody.js";
import { loginSchema, registerSchema } from "../../schemas/auth.schema.js";

const authRouter = Router();

authRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

authRouter.post("/register", registerRateLimit, validateBody(registerSchema), register);
authRouter.post("/login", loginRateLimit, validateBody(loginSchema), login);
authRouter.post("/logout", logout);
authRouter.get("/me", authenticate, me);

export default authRouter;
