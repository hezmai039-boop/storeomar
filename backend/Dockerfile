FROM node:22-slim

# Prisma's schema/query engines need OpenSSL to negotiate TLS — required
# here since Neon (and most managed Postgres) mandates SSL. node:*-slim
# doesn't include it, and without it Prisma silently falls back to a
# guessed engine that fails to connect at all (see the "Schema engine
# error" this fixes).
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npx prisma generate

# COMPILE. The image used to ship raw TypeScript and start the server with
# `tsx src/index.ts`, which transpiles every module at runtime — so boot took
# seconds longer, the first request to touch a cold module paid the transpile
# again, and the process carried a whole compiler in memory for the life of
# the container. package.json already had `build` and `start` scripts doing
# exactly the right thing; nothing ever ran them.
#
# tsx is still installed and still used, but only for the one-shot Prisma
# scripts in docker-entrypoint.sh (baseline, seed, RLS). Those run once at
# boot, not on any request path.
RUN npm run build

RUN chmod +x docker-entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
