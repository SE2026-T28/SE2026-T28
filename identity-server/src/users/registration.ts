import argon2 from "argon2";
import { Prisma, type User } from "../generated/prisma/client.js";
import { getPrisma } from "../db/prisma.js";

export type RegisterInput = {
  email: string;
  password: string;
};

export class RegistrationError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "EMAIL_EXISTS",
    message: string,
  ) {
    super(message);
    this.name = "RegistrationError";
  }
}

function normalizeAndValidate(input: RegisterInput): RegisterInput {
  if (typeof input.email !== "string" || typeof input.password !== "string") {
    throw new RegistrationError("INVALID_INPUT", "Email và mật khẩu là bắt buộc.");
  }

  const email = input.email.trim().toLowerCase();
  const password = input.password;

  // Kiểm tra định dạng cơ bản ở server; không thay thế xác minh email.
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RegistrationError("INVALID_INPUT", "Email không hợp lệ.");
  }

  // Chính sách MVP; không tự động trim mật khẩu.
  if (password.length < 8 || password.length > 128) {
    throw new RegistrationError(
      "INVALID_INPUT",
      "Mật khẩu phải có từ 8 đến 128 ký tự.",
    );
  }

  return { email, password };
}

export type PublicUser = Pick<User, "id" | "email" | "createdAt">;

const MAX_CONCURRENT_PASSWORD_HASHES = 8;

class PasswordHashSemaphore {
  private available = MAX_CONCURRENT_PASSWORD_HASHES;
  private readonly waiters: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}

const passwordHashSemaphore = new PasswordHashSemaphore();

class BulkPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Bulk user persistence failed", { cause });
    this.name = "BulkPersistenceError";
  }
}

async function createUser(
  input: RegisterInput,
  mapPersistenceErrors = false,
): Promise<PublicUser> {
  const releaseHash = await passwordHashSemaphore.acquire();
  let passwordHash: string;
  try {
    passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });
  } finally {
    releaseHash();
  }

  try {
    return await getPrisma().user.create({
      data: { email: input.email, passwordHash },
      select: { id: true, email: true, createdAt: true },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new RegistrationError("EMAIL_EXISTS", "Email đã được đăng ký.");
    }
    if (mapPersistenceErrors) {
      throw new BulkPersistenceError(error);
    }
    throw error;
  }
}

export async function registerUser(input: RegisterInput): Promise<PublicUser> {
  const valid = normalizeAndValidate(input);
  return createUser(valid);
}

export type BulkRegistrationResult =
  | { index: number; status: "succeeded"; user: PublicUser }
  | { index: number; status: "failed"; error: { code: string } };

export async function importUsers(inputs: unknown[]): Promise<BulkRegistrationResult[]> {
  const claimedEmails = new Set<string>();
  const results: BulkRegistrationResult[] = [];

  for (const [index, input] of inputs.entries()) {
    try {
      if (input === null || typeof input !== "object") {
        throw new RegistrationError("INVALID_INPUT", "Dữ liệu người dùng không hợp lệ.");
      }
      const valid = normalizeAndValidate(input as RegisterInput);
      if (claimedEmails.has(valid.email)) {
        results.push({ index, status: "failed", error: { code: "EMAIL_EXISTS" } });
        continue;
      }

      claimedEmails.add(valid.email);
      const user = await createUser(valid, true);
      results.push({ index, status: "succeeded", user });
    } catch (error) {
      if (error instanceof RegistrationError) {
        results.push({ index, status: "failed", error: { code: error.code } });
      } else if (error instanceof BulkPersistenceError) {
        results.push({ index, status: "failed", error: { code: "PERSISTENCE_ERROR" } });
      } else {
        results.push({ index, status: "failed", error: { code: "HASH_ERROR" } });
      }
    }
  }

  return results;
}
