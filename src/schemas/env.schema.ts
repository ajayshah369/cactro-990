import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),

  NODE_ENV: z.enum(["development", "test", "production"]),

  DB_HOST: z.string().trim().min(1, "DB_HOST is required"),

  DB_PORT: z.coerce.number().int().min(1).max(65535),

  DB_NAME: z.string().trim().min(1, "DB_NAME is required"),

  DB_USER: z.string().trim().min(1, "DB_USER is required"),

  DB_PASSWORD: z.string().min(1, "DB_PASSWORD is required"),

  BE_URL: z.string().min(1, "BE_URL is required"),
});
