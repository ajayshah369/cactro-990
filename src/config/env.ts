import "dotenv/config";
import { envSchema } from "../schemas/env.schema.js";

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const errors = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment variables:\n${errors}`);
}

export const env = result.data;
