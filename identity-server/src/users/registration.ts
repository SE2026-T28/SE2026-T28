import argon2 from "argon2";
import { Prisma, type User } from "../generated/prisma/client.js";
import { prisma } from "../db/prisma.js";

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
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new RegistrationError("INVALID_INPUT", "Email không hợp lệ.");
  }

  // Chính sách tối thiểu cho MVP; không tự động trim mật khẩu.
  if (password.length < 8 || password.length > 128) {
    throw new RegistrationError(
      "INVALID_INPUT",
      "Mật khẩu phải có từ 8 đến 128 ký tự.",
    );
  }

  return { email, password };
}

export type PublicUser = Pick<User, "id" | "email" | "createdAt">;

export async function registerUser(input: RegisterInput): Promise<PublicUser> {
  const valid = normalizeAndValidate(input);
  const passwordHash = await argon2.hash(valid.password, {
    type: argon2.argon2id,
  });

  try {
    const user = await prisma.user.create({
      data: {
        email: valid.email,
        passwordHash,
      },
      select: {
        id: true,
        email: true,
        createdAt: true,
      },
    });
    return user;
  } catch (error) {
    // Unique index trong PostgreSQL là lớp bảo vệ cuối cùng trước đăng ký đồng thời.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new RegistrationError("EMAIL_EXISTS", "Email đã được đăng ký.");
    }
    throw error;
  }
}
