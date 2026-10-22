import { Router } from "express";
import { registerUser, RegistrationError } from "./registration.js";

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
