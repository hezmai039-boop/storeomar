import crypto from "node:crypto";
import path from "node:path";
import { localStorageProvider } from "./local";
import { s3StorageProvider } from "./s3";
import { StorageProvider } from "./types";

// Adding a storage backend = write an adapter + add one line here. Mirrors
// src/lib/email/registry.ts and src/modules/billing/adapters/registry.ts.
const providers: Record<string, StorageProvider> = {
  [localStorageProvider.key]: localStorageProvider,
  [s3StorageProvider.key]: s3StorageProvider,
};

/**
 * The provider selected by STORAGE_PROVIDER, defaulting to `local`.
 *
 * Unlike getEmailProvider(), an unknown key throws instead of quietly
 * falling back. The email registry can fall back because the worst case of a
 * typo there is a mail that goes to stdout — recoverable, and the signup it
 * sits on must not break. Here the fallback IS the bug this module exists to
 * fix: STORAGE_PROVIDER=s3 misspelled as "S3" would send every production
 * upload to an ephemeral container disk and lose it at the next deploy, with
 * nothing in the logs and nothing broken until a customer asks for a file
 * back months later. A failing upload is loud, obvious and fixable in a
 * minute; silent data loss is neither.
 */
export function getStorageProvider(): StorageProvider {
  // Read at call time, not module load, so tests and a config change on
  // restart both take effect without import-order games.
  const key = process.env.STORAGE_PROVIDER || localStorageProvider.key;
  const provider = providers[key];
  if (!provider) {
    throw new Error(
      `Unknown STORAGE_PROVIDER "${key}" — expected one of: ${Object.keys(providers).join(", ")}`
    );
  }
  return provider;
}

/**
 * Strips everything that could make a filename mean something other than "a
 * name": directory separators, control characters and dot-runs. The result
 * is a single path component, never `..`, never absolute, never hidden.
 *
 * Arabic (and any other non-ASCII) characters are deliberately preserved —
 * customers upload «سياسة الاستبدال.pdf» and mangling that into hex makes
 * the download filename useless. Non-ASCII is safe: S3 keys are UTF-8, and
 * s3.ts RFC-3986-encodes every key segment before signing.
 */
export function sanitizeFilename(original: string): string {
  const base = original.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.{2,}/g, ".") // "..", "..." — the traversal building block
    .replace(/^\.+/, "") // no leading dot: no ".ssh", no relative-looking names
    .trim();
  // 120 chars keeps the whole key comfortably under S3's 1024-byte limit even
  // when every character is a 2-byte Arabic letter.
  return cleaned.slice(0, 120) || "file";
}

/**
 * The prefix every object belonging to one store lives under.
 *
 * The storeId is escaped rather than trimmed, and deliberately NOT with
 * sanitizeFilename: that function keeps the last path component, so
 * "../store-b" would come out as "store-b" and land inside a *real other
 * tenant's* prefix — turning a traversal attempt into a cross-tenant write.
 * Substituting the offending characters instead makes any tampered id map to
 * a prefix that cannot collide with a legitimate one. Store ids are
 * UUID/cuid-shaped, so this is a no-op for every real value.
 */
export function storageKeyPrefix(storeId: string): string {
  const safeStoreId = storeId.replace(/[^A-Za-z0-9_-]/g, "_") || "unknown";
  return `stores/${safeStoreId}/knowledge/`;
}

/**
 * The one place storage keys are minted, so tenant scoping is structural
 * rather than a convention each call site has to remember.
 *
 * Shape: `stores/<storeId>/knowledge/<uuid>-<filename>`. The UUID prevents
 * two uploads of "policy.pdf" from overwriting each other, and — because it
 * is unguessable — means a key leaked in a log is not a template for
 * enumerating a store's other documents.
 */
export function buildStorageKey(storeId: string, originalName: string): string {
  return `${storageKeyPrefix(storeId)}${crypto.randomUUID()}-${sanitizeFilename(originalName)}`;
}

/** Content type to store an upload with, falling back to opaque bytes. */
export function contentTypeForFile(originalName: string, declaredMime?: string): string {
  if (declaredMime) return declaredMime;
  const ext = path.extname(originalName).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/octet-stream";
}
