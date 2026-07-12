import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// Local-disk storage for uploaded knowledge files. Production note: mount
// UPLOADS_DIR as a volume (docker-compose.yml already does) so files
// survive container restarts — but even if this storage were lost, the
// text extracted at upload time is already durable in knowledge_chunks,
// so search/AI answers keep working; only "view original file" would break.
const UPLOADS_DIR = process.env.UPLOADS_DIR ?? path.join(__dirname, "..", "..", "uploads");

function safeName(original: string): string {
  const ext = path.extname(original).replace(/[^a-zA-Z0-9.]/g, "");
  return `${crypto.randomUUID()}${ext}`;
}

export function saveUploadedFile(storeId: string, originalName: string, buffer: Buffer): string {
  const dir = path.join(UPLOADS_DIR, storeId);
  fs.mkdirSync(dir, { recursive: true });
  const filename = safeName(originalName);
  fs.writeFileSync(path.join(dir, filename), buffer);
  // Relative path stored in knowledge_sources.file_url; served via the
  // authenticated download route, not a public static mount.
  return `${storeId}/${filename}`;
}

export function readStoredFile(relativePath: string): Buffer {
  // relativePath always comes from a DB column we wrote ourselves
  // (uuid-based filename), never directly from user input at read time —
  // still resolve-and-check to rule out any path traversal.
  const resolved = path.resolve(UPLOADS_DIR, relativePath);
  if (!resolved.startsWith(path.resolve(UPLOADS_DIR))) {
    throw new Error("Invalid stored file path");
  }
  return fs.readFileSync(resolved);
}
