import { z } from "zod";
import { UserRole } from "../generated/prisma/enums.js";

const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const registerSchema = z.strictObject({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: emailSchema,
  // Preserve passwords exactly as entered, including spaces.
  password: z
    .string()
    .min(6, "Password must contain at least 12 characters")
    .max(128),
  role: z.enum(UserRole).default(UserRole.CUSTOMER),
});

export const loginSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1, "Password is required").max(128),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
