import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { errorHandler } from "../errorHandler";
import { ApiError } from "../../lib/errors";

// errorHandler is the single place that decides what a client sees when
// anything goes wrong, so a gap in it is a gap on every route at once —
// which is exactly what the ZodError branch was: every `schema.parse()`
// failure in the API answered 500 "حدث خطأ غير متوقع", discarding the Arabic
// message the schema author wrote and logging a stack trace for what was
// only ever a typo.

type Captured = { status: number; body: unknown };

/** The two Express methods errorHandler actually calls. */
function fakeRes(): { res: any; captured: () => Captured } {
  let status = 200;
  let body: unknown = null;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: unknown) {
      body = payload;
      return this;
    },
  };
  return { res, captured: () => ({ status, body }) };
}

function run(err: unknown): Captured {
  const { res, captured } = fakeRes();
  errorHandler(err, {} as any, res, (() => {}) as any);
  return captured();
}

test("a validation failure is 400, not 500", () => {
  const schema = z.object({ email: z.string().email("البريد الإلكتروني غير صحيح") });
  const result = schema.safeParse({ email: "nope" });
  assert.equal(result.success, false);
  if (result.success) return;

  const { status, body } = run(result.error);
  assert.equal(status, 400);
  assert.equal((body as any).error.code, "VALIDATION_ERROR");
});

test("the message shown is the schema's own Arabic text", () => {
  // The whole point: a form can render this string directly. A generic
  // "حدث خطأ غير متوقع" leaves the visitor with no idea which field to fix.
  const schema = z.object({ phone: z.string().min(9, "رقم الجوال غير صحيح") });
  const result = schema.safeParse({ phone: "05" });
  if (result.success) return assert.fail("expected a parse failure");

  const { body } = run(result.error);
  assert.equal((body as any).error.message, "رقم الجوال غير صحيح");
});

test("the first issue becomes the message and every issue stays in details", () => {
  // One line for the UI, the full list for a form that wants to highlight
  // fields — joining them all into `message` renders as a wall of noise.
  const schema = z.object({
    name: z.string().min(2, "اكتب اسمك"),
    email: z.string().email("البريد الإلكتروني غير صحيح"),
  });
  const result = schema.safeParse({ name: "", email: "x" });
  if (result.success) return assert.fail("expected a parse failure");

  const { body } = run(result.error);
  assert.equal((body as any).error.message, "اكتب اسمك");
  const issues = (body as any).error.details.issues as Array<{ path: string; message: string }>;
  assert.equal(issues.length, 2);
  assert.deepEqual(
    issues.map((i) => i.path),
    ["name", "email"]
  );
});

test("a nested field reports a dotted path the client can map to an input", () => {
  const schema = z.object({ contact: z.object({ email: z.string().email("بريد غير صحيح") }) });
  const result = schema.safeParse({ contact: { email: "x" } });
  if (result.success) return assert.fail("expected a parse failure");

  const issues = (run(result.error).body as any).error.details.issues;
  assert.equal(issues[0].path, "contact.email");
});

test("ApiError still wins — the new branch did not shadow it", () => {
  const { status, body } = run(ApiError.notFound("الفاتورة"));
  assert.equal(status, 404);
  assert.equal((body as any).error.code, "NOT_FOUND");
});

test("an unexpected error is still a 500 that leaks nothing", () => {
  // The generic branch must stay generic: a database error's text can carry
  // a query, a column name, or a value from another tenant's row.
  const { status, body } = run(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
  assert.equal(status, 500);
  assert.equal((body as any).error.code, "INTERNAL_ERROR");
  assert.equal((body as any).error.message, "حدث خطأ غير متوقع");
  assert.ok(!JSON.stringify(body).includes("10.0.0.5"));
});
