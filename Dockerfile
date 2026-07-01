# Stage 1: Install dependencies
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install

# Stage 2: Build the application
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN rm -rf data __tests__ __mocks__
RUN npm run build

# Stage 3: Production runner
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# Absolute DB path so the SQLite file always resolves to the mounted volume,
# regardless of the runtime working directory (Next.js standalone is not /app-cwd safe).
ENV DATABASE_PATH=/app/data/database.sqlite

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    mkdir -p /app/data

# Copy Next.js standalone output (includes traced node_modules)
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy cron, migration, and email files
COPY --from=builder --chown=nextjs:nodejs /app/cron.js ./
COPY --from=builder --chown=nextjs:nodejs /app/email ./email
COPY --from=builder --chown=nextjs:nodejs /app/database ./database
COPY --from=builder --chown=nextjs:nodejs /app/.sequelizerc ./.sequelizerc
COPY --from=builder --chown=nextjs:nodejs /app/entrypoint.sh ./entrypoint.sh

# Install packages needed at runtime that are NOT reliably traced
# into the standalone node_modules by Next.js:
# - croner, cryptr, dotenv: used by cron.js (runs outside Next.js)
# - @googleapis/searchconsole: Google API packages have complex module
#   resolution that Next.js 12 file tracing (nft) does not follow
# - @modelcontextprotocol/sdk: the hosted HTTP MCP route (pages/api/mcp) imports it via
#   ESM subpaths (".../server/mcp.js", ".../server/streamableHttp.js"). Next externalizes the
#   ESM-only SDK (keeps the runtime import instead of bundling it), but nft does NOT trace those
#   ESM subpath imports into the standalone node_modules, so the package is simply absent at
#   runtime and /api/mcp 500s with ERR_MODULE_NOT_FOUND. Same class as @googleapis/searchconsole.
#   Installing it here also pulls its runtime transitive deps (zod, express, etc.) into node_modules.
#   Pin to the version in package.json (^1.29.0 -> 1.29.0) so the image matches the built code.
# - sequelize-cli: used by entrypoint.sh for DB migrations
# - concurrently: process manager for server.js + cron.js
RUN chmod +x /app/entrypoint.sh && \
    rm -f package.json && npm init -y && \
    npm install --no-package-lock \
      croner@9.0.0 \
      cryptr@6.4.0 \
      dotenv@16.0.3 \
      @googleapis/searchconsole@1.0.5 \
      @modelcontextprotocol/sdk@1.29.0 \
      sequelize-cli@6.6.5 \
      concurrently@7.6.0 \
      pg@8.13.1 \
      pg-hstore@2.3.4 \
      @isaacs/ttlcache@1.4.1 && \
    npm cache clean --force && \
    rm -rf /tmp/* /root/.npm

# NOTE: we intentionally do NOT set `USER nextjs`. Railway mounts the data volume
# at /app/data root-owned at runtime, so the container runs as root to read and
# write the SQLite database there with no permission mismatch.

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["npx", "concurrently", "node server.js", "node cron.js"]