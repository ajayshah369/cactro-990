import { z } from "zod";

export const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),

  NODE_ENV: z.enum(["development", "test", "production"]),

  DB_HOST: z.string().trim().min(1, "DB_HOST is required"),

  DB_PORT: z.coerce.number().int().min(1).max(65535),

  DB_NAME: z.string().trim().min(1, "DB_NAME is required"),

  DB_USER: z.string().trim().min(1, "DB_USER is required"),

  DB_PASSWORD: z.string().min(1, "DB_PASSWORD is required"),

  BE_URL: z.url()
    .transform((value) => new URL(value).toString())
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "BE_URL must use http or https",
    }),

  JWT_SECRET: z.string().min(32, "JWT_SECRET must contain at least 32 characters"),

  JWT_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),

  NOTIFICATION_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  NOTIFICATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  NOTIFICATION_RETRY_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  NOTIFICATION_LEASE_MS: z.coerce.number().int().min(1000).max(300_000).default(60_000),
});
