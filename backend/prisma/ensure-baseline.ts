import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";

// Makes `prisma migrate deploy` safe to run on a database that was built by
// `prisma db push` — which is every deployment created before migrations
// existed, including production.
//
// The problem this removes: migrate deploy refuses to touch a non-empty
// schema it has no migration history for ("The database schema is not empty.
// Read more about how to baseline..."). The documented fix is to record the
// initial migration as already applied — a one-time operation that writes a
// single row and touches no table. But it is a MANUAL step, and it has to
// happen on the deployed code (which is where the migrations directory
// lives) while the deploy that ships that code is the very thing the missing
// baseline blocks. That ordering trap is what this script exists to break.
//
// Three states, one of which acts:
//
//   1. Fresh, empty database        → do nothing; migrate deploy creates all.
//   2. Built by db push, no history → baseline 0_init, then deploy applies
//                                     only the migrations that came after.
//   3. Already has history          → do nothing; deploy applies what's due.
//
// Safety: it only baselines when app tables exist AND there is no history at
// all. It never runs if _prisma_migrations is present, so it cannot mark a
// later migration as applied and skip real work — the worst case if the
// detection were wrong is a refusal, not a silent partial apply.

const BASELINE = "0_init";

/**
 * Checked BEFORE PrismaClient is constructed — the client validates both
 * connection strings at instantiation, so anything later never runs.
 *
 * Prisma's own P1013 ("The scheme is not recognized in database URL") names
 * neither the offending variable nor its contents, and the schema reads two
 * of them. The realistic mistake is pasting from a provider dashboard with a
 * format still selected: Neon's ".env" option yields
 * `DATABASE_URL=postgresql://…` and its "psql" option yields
 * `psql 'postgresql://…'` — both a faithful copy of the wrong thing. Naming
 * the variable and showing its opening characters turns a long hunt into an
 * obvious fix.
 */
function assertConnectionStrings(): void {
  for (const name of ["DATABASE_URL", "DIRECT_DATABASE_URL"] as const) {
    // DIRECT_DATABASE_URL legitimately falls back to DATABASE_URL where
    // there is no pooler, so only complain when it is set to something.
    const value = process.env[name];
    if (name === "DIRECT_DATABASE_URL" && !value) continue;
    if (!value) throw new Error(`${name} is not set.`);
    if (!/^postgres(ql)?:\/\//.test(value)) {
      const shown = value.slice(0, 28).replace(/:[^:@/]*@/, ":***@");
      throw new Error(
        `${name} must start with postgresql:// or postgres://, but starts with "${shown}…".\n` +
          `It looks like the value carries something before the scheme — a "VARNAME=" prefix, ` +
          `a "psql " prefix, or surrounding quotes. Paste only the connection string itself.`
      );
    }
  }
}

async function main() {
  assertConnectionStrings();
  const prisma = new PrismaClient();
  try {
    const [{ has_history, has_tables }] = await prisma.$queryRaw<
      Array<{ has_history: boolean; has_tables: boolean }>
    >`
      SELECT
        to_regclass('public._prisma_migrations') IS NOT NULL AS has_history,
        to_regclass('public.users')              IS NOT NULL AS has_tables
    `;

    if (has_history) {
      console.log("[baseline] migration history present — nothing to do.");
      return;
    }
    if (!has_tables) {
      console.log("[baseline] empty database — migrate deploy will create everything.");
      return;
    }

    console.log(`[baseline] existing schema with no migration history — recording ${BASELINE} as applied.`);
    // Through the CLI rather than an INSERT: the row's shape (checksum,
    // timestamps, applied_steps_count) is Prisma's to own, and hand-writing
    // it is how a history that looks valid but fails the next checksum
    // comparison gets created.
    // The locally installed binary, NOT `npx prisma`. npx resolves the
    // latest published major when the local copy is not on its lookup path
    // and downloads it — this script hit exactly that, silently running
    // Prisma 7 against a project pinned to 5.22 and failing on a flag that
    // major had removed.
    // Validated here rather than letting Prisma report it, because Prisma's
    // P1013 ("The scheme is not recognized in database URL") does not say
    // WHICH variable is wrong or what it actually contains — and the schema
    // reads two of them. The realistic mistake is pasting from a provider's
    // dashboard with a format still selected: Neon's ".env" option yields
    // `DATABASE_URL=postgresql://...` and its "psql" option yields
    // `psql 'postgresql://...'`, both of which are a valid copy of the wrong
    // thing. Naming the variable and showing its first characters turns a
    // ten-minute hunt into an obvious fix.
    const directUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL || "";
    if (!/^postgres(ql)?:\/\//.test(directUrl)) {
      const shown = directUrl.slice(0, 24).replace(/:[^:@/]*@/, ":***@");
      throw new Error(
        `DIRECT_DATABASE_URL must start with postgresql:// or postgres://, but starts with "${shown}…".\n` +
          `The value looks like it carries something before the scheme — a "VARNAME=" prefix, a "psql " prefix, ` +
          `or surrounding quotes. Paste only the connection string itself.`
      );
    }

    const cli = require.resolve("prisma/build/index.js", { paths: [process.cwd()] });
    execFileSync(process.execPath, [cli, "migrate", "resolve", "--applied", BASELINE], {
      stdio: "inherit",
      env: {
        ...process.env,
        // schema.prisma declares directUrl, and Prisma refuses to load the
        // schema at all when that variable resolves to an empty string. The
        // parent process may have it only via a .env the child does not read,
        // so it is passed explicitly — and defaulted to DATABASE_URL for the
        // no-pooler case, matching docker-entrypoint.sh.
        DIRECT_DATABASE_URL: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL,
      },
    });
    console.log(`[baseline] done — ${BASELINE} marked as applied, no tables modified.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[baseline] failed:", err);
  process.exit(1);
});
