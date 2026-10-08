
const { z } = require('zod');

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Tên người dùng cần ít nhất 3 ký tự.')
  .max(30, 'Tên người dùng tối đa 30 ký tự.')
  .regex(
    /^[a-zA-Z0-9_]+$/,
    'Tên người dùng chỉ gồm chữ, số và dấu gạch dưới.'
  );

const emailSchema = z
  .string()
  .trim()
  .email('Email không hợp lệ.')
  .max(254, 'Email tối đa 254 ký tự.');

const passwordSchema = z
  .string()
  .min(12, 'Mật khẩu cần ít nhất 12 ký tự.')
  .max(128, 'Mật khẩu tối đa 128 ký tự.');

const signupSchema = z
  .object({
    username: usernameSchema,
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: passwordSchema,
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Mật khẩu xác nhận không khớp.',
    path: ['confirmPassword'],
  });

const loginSchema = z.object({
  identifier: z
    .string()
    .trim()
    .min(1, 'Vui lòng nhập email hoặc tên người dùng.')
    .max(254, 'Tài khoản tối đa 254 ký tự.'),
  password: z
    .string()
    .min(1, 'Vui lòng nhập mật khẩu.')
    .max(128, 'Mật khẩu tối đa 128 ký tự.'),
});

module.exports = {
  signupSchema,
  loginSchema,
};

