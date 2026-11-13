import { Router } from "express";
import { importUsers, registerUser, RegistrationError } from "./registration.js";

export const userRouter = Router();

userRouter.post("/register", async (req, res, next) => {
  try {
    const user = await registerUser(req.body ?? {});
    res.status(201).json({ user });
  } catch (error) {
    if (error instanceof RegistrationError) {
      const status = error.code === "EMAIL_EXISTS" ? 409 : 400;
      res.status(status).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return;
    }
    next(error);
  }
});

userRouter.post("/import", async (req, res, next) => {
  try {
    if (!req.body || !Array.isArray(req.body.users) || req.body.users.length === 0) {
      res.status(400).json({ error: { code: "INVALID_REQUEST" } });
      return;
    }

    const results = await importUsers(req.body.users);
    const succeeded = results.filter((result) => result.status === "succeeded").length;
    res.status(200).json({
      summary: {
        total: results.length,
        succeeded,
        failed: results.length - succeeded,
      },
      results,
    });
  } catch (error) {
    next(error);
  }
});
