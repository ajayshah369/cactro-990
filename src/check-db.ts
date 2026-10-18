import { prisma } from "./database/database.js";

try {
  await prisma.$queryRaw`SELECT 1`;

  console.log("PostgreSQL connected through Prisma");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
