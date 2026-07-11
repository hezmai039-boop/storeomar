import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";
import "dotenv/config";

// Applies prisma/rls.sql using the same admin connection as migrate/seed
// (DATABASE_URL — the BYPASSRLS role). Prisma Client itself isn't used
// here because `$executeRawUnsafe` doesn't reliably run a file containing
// multiple statements (the DO block + the audit_logs block); `pg`'s simple
// query protocol does.
async function main() {
  const sql = fs.readFileSync(path.join(__dirname, "rls.sql"), "utf8");
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(sql);
    console.log("RLS policies applied.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
