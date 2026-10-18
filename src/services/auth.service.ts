import { randomBytes } from "node:crypto";
import { argon2id, hash, verify } from "argon2";
import createHttpError from "http-errors";
import { prisma } from "../database/database.js";
import { Prisma } from "../generated/prisma/client.js";
import type { LoginInput, RegisterInput } from "../schemas/auth.schema.js";
import { createAccessToken, verifyAccessToken } from "../utils/jwt.js";

const passwordOptions = {
  type: argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  role: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export type AuthUser = Prisma.UserGetPayload<{
  select: typeof publicUserSelect;
}>;

// Unknown emails still perform password verification to reduce timing differences.
const dummyPasswordHash = await hash(
  randomBytes(32).toString("hex"),
  passwordOptions,
);

async function createAuthResponse(user: AuthUser) {
  return {
    user,
    accessToken: await createAccessToken(user.id, user.role),
  };
}

export async function registerUser(input: RegisterInput) {
  const passwordHash = await hash(input.password, passwordOptions);
  let user: AuthUser;

  try {
    user = await prisma.user.create({
      data: {
        name: input.name,
        email: input.email,
        passwordHash,
        role: input.role,
      },
      select: publicUserSelect,
    });
  } catch (error) {
    // The database constraint also handles simultaneous registrations for one email.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw createHttpError(409, "An account with this email already exists");
    }

    throw error;
  }

  return createAuthResponse(user);
}

export async function loginUser(input: LoginInput) {
  const existingUser = await prisma.user.findFirst({
    where: { email: input.email, deletedAt: null },
    select: { ...publicUserSelect, passwordHash: true },
  });

  const passwordMatches = await verify(
    existingUser?.passwordHash ?? dummyPasswordHash,
    input.password,
  );

  if (!existingUser || !passwordMatches) {
    throw createHttpError(401, "Invalid email or password");
  }

  // Select the public fields explicitly so the hash never reaches an API response.
  return createAuthResponse({
    id: existingUser.id,
    name: existingUser.name,
    email: existingUser.email,
    role: existingUser.role,
    createdAt: existingUser.createdAt,
  });
}

export async function getAuthenticatedUser(token: string): Promise<AuthUser> {
  const { userId } = await verifyAccessToken(token);
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: publicUserSelect,
  });

  if (!user) {
    throw createHttpError(401, "Invalid or expired access token");
  }

  // Fetch the current role so role changes and soft deletions take effect immediately.
  return user;
}
