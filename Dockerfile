FROM oven/bun:1.4 AS base
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY apps/cli/package.json apps/cli/
COPY apps/worker/package.json apps/worker/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/llm/package.json packages/llm/
RUN bun install --frozen-lockfile --production
COPY . .
ENV NODE_ENV=production
USER bun
CMD ["bun", "run", "worker"]
