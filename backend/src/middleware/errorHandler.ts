import { NextFunction, Request, Response } from "express";
import { MulterError } from "multer";
import { ZodError } from "zod";
import { ApiError } from "../lib/errors";

// Last middleware in the chain — turns any thrown/next(err) into the
// uniform envelope from docs/06-api-design.md §0.
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Every route in this API validates with `schema.parse(req.body)`, and
  // without this branch every one of those failures fell through to the 500
  // below: a mistyped email answered "حدث خطأ غير متوقع" with the Arabic
  // message the schema author wrote ("البريد الإلكتروني غير صحيح") thrown
  // away, and the console.error made real incidents harder to find by
  // burying them in ordinary typos. A validation failure is the client's
  // fault by definition — 400, not 500.
  //
  // `message` is the FIRST issue rather than a join of all of them: the UI
  // renders it as one line, and a wall of concatenated field errors is read
  // as noise. The full list stays in `details.issues` for a form that wants
  // to highlight fields.
  //
  // Safe to expose: these strings are written by us in the schema, never
  // derived from the value that failed, so nothing about the request or the
  // database leaks through them.
  if (err instanceof ZodError) {
    const issues = err.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: issues[0]?.message ?? "البيانات المُرسلة غير صالحة",
        details: { issues },
      },
    });
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
