import { test } from "node:test";
import assert from "node:assert/strict";
import { requireTenant } from "../tenantGuard";
import { ApiError } from "../../../lib/errors";

test("requireTenant accepts a valid UUID and returns it unchanged", () => {
  const id = "11111111-1111-1111-1111-111111111111";
  assert.equal(requireTenant(id, "test"), id);
});

test("requireTenant rejects undefined", () => {
  assert.throws(() => requireTenant(undefined, "test"), ApiError);
});

test("requireTenant rejects null", () => {
  assert.throws(() => requireTenant(null, "test"), ApiError);
});

test("requireTenant rejects an empty string", () => {
  assert.throws(() => requireTenant("", "test"), ApiError);
});

test("requireTenant rejects a non-UUID string (e.g. accidental store name)", () => {
  assert.throws(() => requireTenant("my-store", "test"), ApiError);
});

test("requireTenant rejects a SQL-injection-shaped string", () => {
  assert.throws(() => requireTenant("' OR '1'='1", "test"), ApiError);
});

test("requireTenant error carries 400 status and a stable error code", () => {
  try {
    requireTenant(undefined, "unit-test-context");
    assert.fail("expected requireTenant to throw");
  } catch (err) {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 400);
    assert.equal(err.code, "TENANT_CONTEXT_MISSING");
  }
});
