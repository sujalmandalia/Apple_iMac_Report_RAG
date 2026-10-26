import type { ErrorRequestHandler } from "express";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const httpError = (status: number, message: string) => new HttpError(status, message);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: status >= 500 && !(err instanceof HttpError) ? "Internal server error" : err.message,
  });
};
