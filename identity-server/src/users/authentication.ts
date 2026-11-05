
import argon2 from "argon2";
import type { User } from "../generated/prisma/client.js";
import { getPrisma } from "../db/prisma.js";

/**
 * Dữ liệu account được phép cung cấp cho Provider.
 * Không bao gồm passwordHash.
 */
export type AccountForProvider = Pick<User, "id" | "email">;

export type AuthenticationResult = {
  success: true;
  account: AccountForProvider;
};

export type AuthenticationFailure = {
  success: false;
};

/**
 * Chuẩn hóa email giống A1:
 * trim() và chuyển về chữ thường.
 */
export function normalizeEmail(email: string): string | null {
  if (typeof email !== "string") {
    return null;
  }

  const normalized = email.trim().toLowerCase();

  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

/**
 * Tra cứu account bằng ID.
 */
export async function findUserById(
  id: string,
): Promise<AccountForProvider | null> {
  if (typeof id !== "string" || !id.trim()) {
    return null;
  }

  return getPrisma().user.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
    },
  });
}

/**
 * Tra cứu account bằng email.
 */
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
 * Kiểm tra thông tin đăng nhập.
 *
 * Thành công: trả về ID và email.
 * Thất bại: trả về cùng một kết quả false.
 *
 * Không bao giờ trả passwordHash ra ngoài.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<AuthenticationResult | AuthenticationFailure> {
  const normalizedEmail = normalizeEmail(email);

  if (
    !normalizedEmail ||
    typeof password !== "string" ||
    password.length < 8 ||
    password.length > 128
  ) {
    return { success: false };
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
    return { success: false };
  }

  let passwordMatches = false;

  try {
    passwordMatches = await argon2.verify(
      user.passwordHash,
      password,
    );
  } catch {
    // Hash không hợp lệ cũng không được tiết lộ cho người dùng.
    return { success: false };
  }

  if (!passwordMatches) {
    return { success: false };
  }

  return {
    success: true,
    account: {
      id: user.id,
      email: user.email,
    },
  };
}
