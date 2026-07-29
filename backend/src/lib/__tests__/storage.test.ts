import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Every provider reads its configuration at call time, not at module load,
// so these assignments hold regardless of how the bundler orders imports.
// The scratch directory keeps the tests from ever touching a developer's
// real upload directory. No test in this file touches the network.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-storage-test-"));
process.env.STORAGE_LOCAL_DIR = SCRATCH;
delete process.env.STORAGE_PROVIDER;
delete process.env.SENTRY_DSN;

import { buildStorageKey, getStorageProvider, sanitizeFilename, storageKeyPrefix } from "../storage/registry";
import { localStorageProvider } from "../storage/local";
import { captureError } from "../observability";

test("storage keys are scoped to the store that owns the file", () => {
  const key = buildStorageKey("store-a", "policy.pdf");
  assert.ok(key.startsWith("stores/store-a/knowledge/"), key);
  // The prefix is what makes a bucket policy or a leaked key unable to
  // address another tenant: store-b's objects can never share this prefix.
  assert.equal(key.startsWith(storageKeyPrefix("store-b")), false);
});

test("two uploads of the same filename get distinct keys", () => {
  // Without this, a store re-uploading "policy.pdf" would silently overwrite
  // the version an older knowledge_source row still points at.
  const a = buildStorageKey("store-a", "policy.pdf");
  const b = buildStorageKey("store-a", "policy.pdf");
  assert.notEqual(a, b);
  assert.ok(a.endsWith("-policy.pdf"));
});

test("a filename with '../' cannot escape the store prefix", () => {
  const key = buildStorageKey("store-a", "../../../../etc/passwd");
  assert.ok(key.startsWith("stores/store-a/knowledge/"), key);
  assert.equal(key.includes(".."), false);
  assert.equal(key.includes("etc/passwd"), false);
  // Exactly four segments — the traversal collapsed to a single component.
  assert.equal(key.split("/").length, 4);
});

test("a malicious storeId cannot address another store's prefix", () => {
  // The dangerous outcome is not "..' survives" — it is "../store-b" being
  // normalised down to store-b, which would put one tenant's object inside
  // another tenant's prefix.
  const key = buildStorageKey("../store-b", "policy.pdf");
  assert.equal(key.includes(".."), false);
  assert.equal(key.startsWith(storageKeyPrefix("store-b")), false);
  assert.equal(key.split("/").length, 4);
});

test("sanitizeFilename strips separators, dot-runs and leading dots but keeps Arabic", () => {
  assert.equal(sanitizeFilename("..\\..\\windows\\system32\\cmd.exe"), "cmd.exe");
  assert.equal(sanitizeFilename("...."), "file");
  assert.equal(sanitizeFilename(""), "file");
  assert.equal(sanitizeFilename(".ssh"), "ssh");
  // Customers upload Arabic filenames; mangling them makes the download
  // filename useless, and S3 keys are UTF-8 anyway.
  assert.equal(sanitizeFilename("سياسة الاستبدال.pdf"), "سياسة الاستبدال.pdf");
});

test("local provider round-trips put → get → delete", async () => {
  const key = buildStorageKey("store-a", "round-trip.pdf");
  const body = Buffer.from("سياسة الاستبدال — 40 صفحة", "utf8");

  const { url } = await localStorageProvider.put({ key, body, contentType: "application/pdf" });
  assert.ok(url.startsWith("file://"));

  const fetched = await localStorageProvider.get(key);
  assert.ok(fetched, "expected the stored object to come back");
  assert.equal(Buffer.compare(fetched, body), 0);

  await localStorageProvider.delete(key);
  assert.equal(await localStorageProvider.get(key), null);
});

test("local provider returns null for a missing key instead of throwing", async () => {
  // This is the shape of every file lost to a container restart: the DB row
  // exists, the object does not, and the download route must be able to
  // answer 404 rather than 500.
  assert.equal(await localStorageProvider.get("stores/store-a/knowledge/never-written.pdf"), null);
});

test("local provider delete is idempotent", async () => {
  await localStorageProvider.delete("stores/store-a/knowledge/never-written.pdf");
});

test("local provider refuses a key that escapes its root", async () => {
  await assert.rejects(() => localStorageProvider.get("../../../../etc/passwd"));
});

test("getStorageProvider defaults to local when STORAGE_PROVIDER is unset", () => {
  delete process.env.STORAGE_PROVIDER;
  assert.equal(getStorageProvider().key, "local");
});

test("getStorageProvider resolves s3 by key and rejects an unknown one", () => {
  process.env.STORAGE_PROVIDER = "s3";
  assert.equal(getStorageProvider().key, "s3");

  // Loud failure over a silent fall back to the data-losing local disk.
  process.env.STORAGE_PROVIDER = "S3";
  assert.throws(() => getStorageProvider(), /Unknown STORAGE_PROVIDER/);
  delete process.env.STORAGE_PROVIDER;
});

test("captureError never throws without a DSN, whatever it is handed", () => {
  delete process.env.SENTRY_DSN;
  captureError(new Error("boom"), { storeId: "store-a" });
  captureError("a bare string was thrown");
  captureError(undefined);
  // A circular object cannot be JSON.stringify'd — the reporter must swallow
  // that too, because every call site is already on a failure path.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  captureError(new Error("boom"), circular);
});

test("captureError tolerates a malformed SENTRY_DSN", () => {
  process.env.SENTRY_DSN = "not-a-dsn";
  captureError(new Error("boom"));
  delete process.env.SENTRY_DSN;
});

after(() => {
  fs.rmSync(SCRATCH, { recursive: true, force: true });
});
