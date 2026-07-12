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

RUN chmod +x docker-entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
