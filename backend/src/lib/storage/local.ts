// ⚠️ DEVELOPMENT ONLY — THIS PROVIDER LOSES DATA. ⚠️
//
// Files are written to the container's own filesystem, under the OS temp
// directory by default. On Render (and any container platform without an
// attached persistent volume) that filesystem is destroyed on every restart,
// every redeploy, every crash-loop recovery and every instance rescale. Every
// file written through this provider is gone at that moment, silently: the
// text extracted at upload time lives in knowledge_chunks, so search and AI
// answers keep working exactly as before, and the loss surfaces only when a
// customer clicks "download the original" months later.
//
// It is the default because the whole upload → extract → download loop must
// run end-to-end with zero external accounts (same principle as
// src/lib/email/console.ts and src/lib/llm.ts). It must NEVER be the provider
// in a deployment holding real customer documents.
//
// Production: set STORAGE_PROVIDER=s3 and the STORAGE_* credentials (see
// s3.ts and docs/28-launch-readiness.md).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StorageProvider } from "./types";

function rootDir(): string {
  // Read at call time, not module load: the registry imports this module on
  // every boot regardless of which provider is selected, and tests point
  // STORAGE_LOCAL_DIR at a scratch directory after import.
  return process.env.STORAGE_LOCAL_DIR || path.join(os.tmpdir(), "atlas-storage");
}

/**
 * Maps a storage key to an absolute path, refusing anything that escapes the
 * root. buildStorageKey() in registry.ts already sanitizes filenames, but
 * this is the layer that turns a key into a filesystem write — the one place
 * where a traversal bug becomes "overwrite /etc/something" — so it re-checks
 * instead of trusting its caller.
 */
function resolveKey(key: string): string {
  const root = path.resolve(rootDir());
  const target = path.resolve(root, key);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Refusing to access storage key outside the root: "${key}"`);
  }
  return target;
}

export const localStorageProvider: StorageProvider = {
  key: "local",

  async put({ key, body }): Promise<{ url: string }> {
    const target = resolveKey(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
    // A file:// URL rather than a path so log lines read the same shape as
    // the s3 provider's https URL, and so an operator can paste it straight
    // into a viewer while developing.
    return { url: `file://${target}` };
  },

  async get(key): Promise<Buffer | null> {
    try {
      return await fs.readFile(resolveKey(key));
    } catch (err) {
      // ENOENT is the expected outcome for every file lost to a restart, so
      // it maps to the contract's "no object" instead of an exception.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  },

  async delete(key): Promise<void> {
    // force:true makes a missing key a no-op, matching the idempotent
    // delete the interface promises (and S3's own DELETE semantics).
    await fs.rm(resolveKey(key), { force: true });
  },
};
