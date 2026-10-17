FROM node:24-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
ENV PORT=8787
EXPOSE 8787
# Seeds the demo graph (deterministic, seed 42) on every start, then serves API + page on one port.
CMD ["sh", "-c", "pnpm generate --seed 42 --reset && pnpm start"]
