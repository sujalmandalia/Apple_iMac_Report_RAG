import type { RequestHandler } from "express";

export const requestLog: RequestHandler = (req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    if (req.path === "/health" || !req.path.match(/^\/(ask|chat|search|conversations)/)) return;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`);
  });
  next();
};
