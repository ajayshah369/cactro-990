import { defineConfig } from "prisma/config";
import { env } from "./src/config/env.js";

const user = encodeURIComponent(env.DB_USER);
const password = encodeURIComponent(env.DB_PASSWORD);
const database = encodeURIComponent(env.DB_NAME);

const databaseUrl =
  `postgresql://${user}:${password}` +
  `@${env.DB_HOST}:${env.DB_PORT}/${database}`;

export default defineConfig({
  schema: "prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: databaseUrl,
  },
});
