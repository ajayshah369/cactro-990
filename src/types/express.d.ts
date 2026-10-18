import type { AuthUser } from "../services/auth.service.js";

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
