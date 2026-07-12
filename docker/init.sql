-- NOTE: docker-compose.yml no longer runs a local Postgres container by
-- default — it points at an external free-tier Neon database instead (see
-- .env.example's NEON_DATABASE_URL). This file is kept for anyone who wants
-- to self-host Postgres instead of using Neon: add back a `postgres:`
-- service in docker-compose.yml, mount this file to
-- /docker-entrypoint-initdb.d/init.sql, and point DATABASE_URL /
-- APP_DATABASE_URL / RESOLVER_DATABASE_URL at the three roles it creates.
--
-- Runs once, automatically, the first time the postgres container starts
-- (docker-entrypoint-initdb.d convention). Sets up the three-role model
-- verified by hand while building this project — see
-- backend/src/config/env.ts and backend/prisma/rls.sql for why each role
-- exists:
--
--   atlas           — POSTGRES_USER, already a full superuser courtesy of
--                     the base image. Used ONLY by the Prisma CLI
--                     (migrate/push/seed) via DATABASE_URL. Superusers
--                     always bypass RLS, which is correct here: schema
--                     setup and seeding are administrative, cross-tenant
--                     operations by nature.
--   atlas_app       — used by the running backend (APP_DATABASE_URL).
--                     NOSUPERUSER, NOBYPASSRLS — every RLS policy in
--                     prisma/rls.sql actually applies to this role.
--   atlas_resolver  — used ONLY to resolve a public webhook's
--                     channel/integration id to its store, before any
--                     store context exists (RESOLVER_DATABASE_URL).
--                     BYPASSRLS, but granted SELECT on exactly 4 tables —
--                     see backend/src/db/resolverClient.ts.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE ROLE atlas_app LOGIN PASSWORD 'atlas_app' NOSUPERUSER NOBYPASSRLS;
CREATE ROLE atlas_resolver LOGIN PASSWORD 'atlas_resolver' NOSUPERUSER BYPASSRLS;

GRANT USAGE ON SCHEMA public TO atlas_app, atlas_resolver;

-- No tables exist yet at container-init time (Prisma creates them right
-- after via `prisma db push`) — so the grants that matter are the DEFAULT
-- ones, applied automatically to every table `atlas` goes on to create.
ALTER DEFAULT PRIVILEGES FOR ROLE atlas IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO atlas_app;

ALTER DEFAULT PRIVILEGES FOR ROLE atlas IN SCHEMA public
  GRANT SELECT ON TABLES TO atlas_resolver;
