// Object storage plugs in the same way email and payment providers do (see
// src/lib/email/types.ts and src/modules/billing/adapters/types.ts):
// implement this interface + register it in registry.ts. Nothing that
// uploads or downloads a file names a provider directly — callers resolve
// one by key — so moving from "the container's own disk" to R2/S3 is a new
// adapter file and one env var, not a rewrite of the knowledge routes.
//
// The reason this seam exists at all: knowledge uploads currently land on
// the container filesystem (src/lib/fileStorage.ts). Render gives each
// service an ephemeral disk that is wiped on every restart and every
// redeploy, so a customer's 40-page policy PDF is gone by the next deploy.
// The extracted text survives in knowledge_chunks — search and AI answers
// keep working, which is exactly why nobody notices — but "download the
// original" is permanently broken for every file uploaded before the last
// restart.

export interface StorageProvider {
  key: string; // "local" | "s3"

  /**
   * Stores `body` at `key`, overwriting any existing object at that key.
   *
   * The returned `url` is for humans and logs (an operator locating the
   * object in a bucket browser). It is deliberately NOT the handle used to
   * read the object back: callers persist the *key* they passed in, because
   * that is what `get`/`delete` take and it stays valid across a provider
   * migration, whereas a URL embeds today's endpoint and bucket.
   */
  put(params: { key: string; body: Buffer; contentType: string }): Promise<{ url: string }>;

  /**
   * Returns the object's bytes, or `null` when no object exists at `key`.
   *
   * Missing is not an error: after the ephemeral-disk data loss described
   * above there are rows in knowledge_sources whose file is simply gone, and
   * the download route needs to answer "غير موجود" rather than a 500.
   */
  get(key: string): Promise<Buffer | null>;

  /** Idempotent — deleting an already-absent key must resolve, not throw. */
  delete(key: string): Promise<void>;
}
