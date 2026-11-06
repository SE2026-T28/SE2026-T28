import argon2 from "argon2";
import type { User } from "../generated/prisma/client.js";
import { getPrisma } from "../db/prisma.js";
import { normalizeEmail } from "./email.js";

export { normalizeEmail } from "./email.js";

/** Public account data accepted by the OIDC Provider. */
export type AccountForProvider = Pick<User, "id" | "email">;

/** Look up a user by stable UUID and expose only public account fields. */
export async function findUserById(
  id: string,
): Promise<AccountForProvider | null> {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim())) {
    return null;
  }

  return getPrisma().user.findUnique({
    where: { id: id.trim() },
    select: {
      id: true,
      email: true,
    },
  });
}

/** Look up a user by normalized email and expose only public account fields. */
export async function findUserByEmail(
  email: string,
): Promise<AccountForProvider | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    return null;
  }

  return getPrisma().user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
    },
  });
}

/**
 * Verify credentials for the Identity Server's OIDC interaction handler.
 *
 * Contract agreed for Provider integration:
 *   authenticateUser(email, password) -> { id, email } | null
 *
 * A null result is used for every credential failure (unknown account,
 * malformed email, invalid password, or malformed stored hash). The caller
 * must not reveal which check failed. passwordHash is never returned.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<AccountForProvider | null> {
  const normalizedEmail = normalizeEmail(email);
  if (
    !normalizedEmail ||
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 128
  ) {
    return null;
  }

  const user = await getPrisma().user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      email: true,
      passwordHash: true,
    },
  });

  if (!user) {
    return null;
  }

  try {
    const passwordMatches = await argon2.verify(user.passwordHash, password);
    if (!passwordMatches) {
      return null;
    }
  } catch {
    // Corrupted/unsupported hashes fail closed without leaking account details.
    return null;
  }

  return {
    id: user.id,
    email: user.email,
  };
}
