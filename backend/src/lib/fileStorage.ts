import fs from "node:fs";
import path from "node:path";
import { captureError } from "./observability";

// LEGACY READ PATH ONLY — nothing writes here any more.
//
// Knowledge uploads used to be written straight to the container's filesystem
// by a saveUploadedFile() that lived in this file. On Render that disk is
// reclaimed on every restart and redeploy, so each of those files was gone by
// the next deploy — silently, because the extracted text survives in
// knowledge_chunks and search kept working. modules/knowledge/routes.ts now
// stores uploads through lib/storage (see docs/28-launch-readiness.md §1) and
// the writer has been deleted rather than deprecated: leaving it exported
// would invite the next upload feature to reach for it again.
//
// What remains is the reader, for rows created before that change. Their
// file_url holds the old `<storeId>/<uuid>.<ext>` relative path, and those
// rows are deliberately NOT migrated — on Render there is nothing left to
// migrate. It still matters for a self-hosted deployment where UPLOADS_DIR is
// a mounted volume (docker-compose.yml does exactly that), where those files
// really are still on disk and a customer can still download them.
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(__dirname, "..", "..", "uploads");

/**
 * Reads a pre-storage-provider upload, or returns null when it is not there.
 *
 * Never throws, by design. Every caller is a download route whose only honest
 * answer for a file lost to an ephemeral disk is 404 "الملف غير متوفر" — an
 * exception here would turn that into a 500 and page someone about a file that
 * was destroyed months ago by a deploy.
 *
 * `relativePath` comes from a database column this codebase wrote, never from
 * the request, but it is still checked against `storeId` and re-resolved: the
 * old writer produced `<storeId>/<filename>`, so anything that does not match
 * that shape is either corrupt or tampered with, and in both cases the answer
 * is "no file" rather than a read outside the store's own directory.
 */
export function readLegacyLocalFile(storeId: string, relativePath: string): Buffer | null {
  if (!relativePath.startsWith(`${storeId}/`)) return null;

  const root = path.resolve(UPLOADS_DIR);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;

  try {
    return fs.readFileSync(resolved);
  } catch (err) {
    // ENOENT is the normal case on any ephemeral disk and is not worth a log
    // line; anything else (permissions, a directory where a file should be) is
    // a real operational problem that would otherwise be invisible, because
    // the route answers 404 either way.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      captureError(err, { scope: "knowledge.download.legacyLocalFile", storeId, relativePath });
    }
    return null;
  }
}
