import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone, planRequestSchema } from "../publicRoutes";

// The public plan-request form is the only unauthenticated WRITE the
// platform exposes to strangers now that self-serve signup is closed, so its
// input handling is worth testing without a database. Both pieces below are
// pure.

// ---------------------------------------------------------------
// Phone normalisation
// ---------------------------------------------------------------

test("every shape a Saudi visitor types normalises to one number", () => {
  // The point of normalising is that the owner can click one WhatsApp link
  // and that the same person filling the form twice is recognised as one
  // lead. These five strings are the same phone.
  const expected = "966538165467";
  for (const input of ["0538165467", "538165467", "+966538165467", "00966538165467", "+966 53 816 5467"]) {
    assert.equal(normalizePhone(input), expected, input);
  }
});

test("separators people paste from a contacts app are stripped", () => {
  assert.equal(normalizePhone("053-816-5467"), "966538165467");
  assert.equal(normalizePhone("  0538165467  "), "966538165467");
  assert.equal(normalizePhone("(053) 816 5467"), "966538165467");
});

test("a number that is not Saudi is kept as typed, not mangled or rejected", () => {
  // A lead is a person. Guessing at a foreign number would produce a
  // WhatsApp link to the wrong human, which is worse than an un-normalised
  // one displayed verbatim next to it.
  assert.equal(normalizePhone("+971501234567"), "+971501234567");
  assert.equal(normalizePhone("+20 100 123 4567"), "+20 100 123 4567");
});

test("normalisation is idempotent", () => {
  // It runs on every submit, including the update path that collapses a
  // repeat request onto an existing row.
  const once = normalizePhone("0538165467");
  assert.equal(normalizePhone(once), once);
});

test("a Saudi-length number that is not a mobile prefix is left alone", () => {
  // 011 is a Riyadh landline. It should not be rewritten as if it were 05x.
  assert.equal(normalizePhone("0112345678"), "0112345678");
});

// ---------------------------------------------------------------
// Validation
// ---------------------------------------------------------------

const valid = { planKey: "pro", name: "عمر", email: "Omar@Example.com", phone: "0538165467" };

test("a minimal valid submission passes and the email is lowercased", () => {
  const parsed = planRequestSchema.parse(valid);
  // Lowercasing is what makes the 24-hour repeat lookup actually match:
  // "Omar@" and "omar@" are one inbox, and without this they are two leads.
  assert.equal(parsed.email, "omar@example.com");
  assert.equal(parsed.name, "عمر");
});

test("the failure messages are the Arabic ones the form shows", () => {
  // These strings reach the visitor verbatim — errorHandler now maps a
  // ZodError to a 400 carrying issues[0].message. A generic message here
  // means a visitor who cannot tell which field is wrong.
  const result = planRequestSchema.safeParse({ ...valid, email: "not-an-email", phone: "05" });
  assert.equal(result.success, false);
  if (result.success) return;
  const messages = result.error.issues.map((i) => i.message);
  assert.ok(messages.includes("البريد الإلكتروني غير صحيح"), messages.join(" | "));
  assert.ok(messages.includes("رقم الجوال غير صحيح"), messages.join(" | "));
});

test("a phone is judged by digit count, not string length", () => {
  // "+966 53 816 5467" is 16 characters and 12 digits; "0000 0000" is 9
  // characters and 8 digits. A .min() on the string would get both wrong.
  assert.equal(planRequestSchema.safeParse({ ...valid, phone: "+966 53 816 5467" }).success, true);
  assert.equal(planRequestSchema.safeParse({ ...valid, phone: "0000 0000" }).success, false);
});

test("a rejected phone reports exactly one error, not two", () => {
  // Regression: the schema originally carried both .min(9) and this refine,
  // so the dialog rendered "رقم الجوال غير صحيح" twice for one field.
  const result = planRequestSchema.safeParse({ ...valid, phone: "05" });
  assert.equal(result.success, false);
  if (result.success) return;
  assert.equal(result.error.issues.filter((i) => i.path[0] === "phone").length, 1);
});

test("optional fields stay optional and are not coerced into empty strings", () => {
  const parsed = planRequestSchema.parse(valid);
  assert.equal(parsed.storeName, undefined);
  assert.equal(parsed.note, undefined);
  assert.equal(parsed.website, undefined);
});

test("the honeypot field is accepted by the schema, never rejected by it", () => {
  // Rejection is the one thing that must NOT happen here: a 400 tells the
  // bot's author which field gave it away. The route accepts the parse and
  // then answers 201 without writing — see publicRoutes.ts.
  assert.equal(planRequestSchema.safeParse({ ...valid, website: "http://spam.example" }).success, true);
});

test("oversized input is refused rather than stored", () => {
  // Every one of these lands in an email sent to the platform owner, so an
  // unbounded field is an unbounded message.
  assert.equal(planRequestSchema.safeParse({ ...valid, name: "ع".repeat(121) }).success, false);
  assert.equal(planRequestSchema.safeParse({ ...valid, note: "x".repeat(2001) }).success, false);
  assert.equal(planRequestSchema.safeParse({ ...valid, storeName: "x".repeat(201) }).success, false);
  assert.equal(planRequestSchema.safeParse({ ...valid, planKey: "x".repeat(61) }).success, false);
});

test("planKey is required — a lead filed against no plan is a lost lead", () => {
  const { planKey: _omitted, ...withoutPlan } = valid;
  assert.equal(planRequestSchema.safeParse(withoutPlan).success, false);
  assert.equal(planRequestSchema.safeParse({ ...valid, planKey: "" }).success, false);
});
