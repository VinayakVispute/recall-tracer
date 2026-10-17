# One container: the Hono API on 8787 (internal) and the Next.js page on $PORT, which proxies /api to it.
FROM node:24-slim AS build
WORKDIR /app
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
COPY web/package.json web/bun.lock web/
# Root deps too: the web build type-checks the API types it imports from src/.
RUN bun install --frozen-lockfile && cd web && bun install --frozen-lockfile
COPY . .
RUN cd web && bun run build

FROM node:24-slim
WORKDIR /app
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src src
COPY data data
# Recorded runs for /recall/replay, so the hosted demo plays without a Claude key.
COPY demo demo
COPY --from=build /app/web/.next/standalone web
COPY --from=build /app/web/.next/static web/.next/static
COPY --from=build /app/web/public web/public
ENV PORT=3000 RECALL_API=http://localhost:8787 HOSTNAME=0.0.0.0
EXPOSE 3000
# Seeds the demo graph (deterministic, seed 42) on every start. If either process dies, the container exits and restarts.
CMD ["sh", "-c", "bun run generate --seed 42 --reset && bun run real && exec npx concurrently -k -n api,web \"PORT=8787 npx tsx src/api/server.ts\" \"node web/server.js\""]
