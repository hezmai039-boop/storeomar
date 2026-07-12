import { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { ApiError } from "../lib/errors";

// Last middleware in the chain — turns any thrown/next(err) into the
// uniform envelope from docs/06-api-design.md §0.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof MulterError) {
    const message = err.code === "LIMIT_FILE_SIZE" ? "حجم الملف يتجاوز الحد المسموح (10 ميجابايت)" : err.message;
    return res.status(400).json({ error: { code: `UPLOAD_${err.code}`, message, details: {} } });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "حدث خطأ غير متوقع", details: {} },
  });
}

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "المسار غير موجود", details: {} } });
}
