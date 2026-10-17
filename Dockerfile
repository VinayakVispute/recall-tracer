FROM node:24-slim
WORKDIR /app
COPY --from=oven/bun:1.3.14 /usr/local/bin/bun /usr/local/bin/bun
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build
ENV PORT=8787
EXPOSE 8787
# Seeds the demo graph (deterministic, seed 42) on every start, then serves API + page on one port.
CMD ["sh", "-c", "bun run generate --seed 42 --reset && bun run start"]
