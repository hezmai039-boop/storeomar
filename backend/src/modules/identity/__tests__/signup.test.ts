import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveOrgSlug, resolveUniqueOrgSlug } from "../routes";

// Slug derivation is the one piece of signup that can silently produce a
// broken tenant without any error: an empty or duplicated slug is not a
// crash, it is an organization nobody can address by URL, or a unique-index
// failure at the very last statement of the signup transaction. It is also
// pure, so it is testable without a database — `exists` is injected.

test("an ASCII name becomes a clean lowercase-hyphen slug", () => {
  assert.equal(deriveOrgSlug("Atlas Store"), "atlas-store");
  assert.equal(deriveOrgSlug("  Nour's Coffee & Tea!! "), "nour-s-coffee-tea");
  assert.equal(deriveOrgSlug("ALREADY-slugged"), "already-slugged");
});

test("an Arabic name derives to the empty string — expected, not an error", () => {
  // Most of this product's customers name their business in Arabic. The
  // derivation is ASCII-only on purpose (slugs live in URLs and log lines),
  // so "nothing usable" is the normal outcome here and the caller must be
  // the one to supply a random slug instead.
  assert.equal(deriveOrgSlug("متجر الغذاء"), "");
  assert.equal(deriveOrgSlug("شركة أطلس للتقنية"), "");
});

test("a mixed Arabic/ASCII name keeps only the ASCII part, without stray hyphens", () => {
  const slug = deriveOrgSlug("متجر Ghidhaak الغذاء");
  assert.equal(slug, "ghidhaak");
  assert.ok(!slug.startsWith("-") && !slug.endsWith("-"));
});

test("slug length is capped so a collision suffix always fits", () => {
  assert.ok(deriveOrgSlug("a".repeat(200)).length <= 40);
});

test("a free slug is used as-is", async () => {
  const slug = await resolveUniqueOrgSlug("Atlas Store", async () => false);
  assert.equal(slug, "atlas-store");
});

test("a taken slug collides forward with a counter", async () => {
  const taken = new Set(["atlas-store", "atlas-store-2"]);
  const slug = await resolveUniqueOrgSlug("Atlas Store", async (s) => taken.has(s));
  assert.equal(slug, "atlas-store-3");
});

test("after the counter is exhausted it falls back to a random suffix, never loops forever", async () => {
  const taken = new Set(["atlas-store", "atlas-store-2", "atlas-store-3", "atlas-store-4", "atlas-store-5"]);
  const slug = await resolveUniqueOrgSlug("Atlas Store", async (s) => taken.has(s), () => "beefcafe");
  assert.equal(slug, "atlas-store-beefcafe");
});

test("an Arabic-only name gets a random slug instead of a bare counter", async () => {
  // "-2" alone would be a nonsense organization identifier, so the empty
  // base must skip the counter branch entirely.
  const slug = await resolveUniqueOrgSlug("متجر الغذاء", async () => false, () => "beefcafe");
  assert.equal(slug, "org-beefcafe");
});

test("two Arabic-named signups never collide, even on the same name", async () => {
  const issued: string[] = [];
  let n = 0;
  const suffixes = ["aaaaaaaa", "bbbbbbbb"];
  for (let i = 0; i < 2; i += 1) {
    const slug = await resolveUniqueOrgSlug("متجر الغذاء", async (s) => issued.includes(s), () => suffixes[n++]);
    issued.push(slug);
  }
  assert.deepEqual(issued, ["org-aaaaaaaa", "org-bbbbbbbb"]);
});

test("a random slug that happens to be taken is retried rather than returned", async () => {
  const taken = new Set(["org-aaaaaaaa"]);
  const suffixes = ["aaaaaaaa", "bbbbbbbb"];
  let n = 0;
  const slug = await resolveUniqueOrgSlug("متجر الغذاء", async (s) => taken.has(s), () => suffixes[n++]);
  assert.equal(slug, "org-bbbbbbbb");
});
