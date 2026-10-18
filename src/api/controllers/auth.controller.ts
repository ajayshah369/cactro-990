import type { RequestHandler } from "express";
import type { LoginInput, RegisterInput } from "../../schemas/auth.schema.js";
import { loginUser, registerUser } from "../../services/auth.service.js";
import { clearAuthCookie, setAuthCookie } from "../../utils/authCookie.js";

export const register: RequestHandler<
  Record<string, never>,
  unknown,
  RegisterInput
> = async (req, res) => {
  const { accessToken, user } = await registerUser(req.body);
  setAuthCookie(res, accessToken);
  res.status(201).json({ success: true, data: user });
};

export const login: RequestHandler<
  Record<string, never>,
  unknown,
  LoginInput
> = async (req, res) => {
  const { accessToken, user } = await loginUser(req.body);
  setAuthCookie(res, accessToken);
  res.status(200).json({ success: true, data: user });
};

export const logout: RequestHandler = (_req, res) => {
  clearAuthCookie(res);
  res.sendStatus(204);
};

export const me: RequestHandler = (req, res) => {
  res.status(200).json({ success: true, data: req.user });
};
