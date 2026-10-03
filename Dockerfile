# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
FROM ${NODE_IMAGE} AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY tsconfig*.json ./
COPY apps apps
COPY packages packages
COPY scripts/build.mjs scripts/build.mjs
COPY scripts/migrate.ts scripts/migrate.ts
COPY scripts/pilot.ts scripts/pilot.ts
COPY scripts/migrate-pilot-issuer.ts scripts/migrate-pilot-issuer.ts
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# One-shot test target; never the installed HTTP server.
FROM dependencies AS test
COPY tsconfig*.json vitest.config.ts ./
COPY apps apps
COPY packages packages
COPY scripts scripts
COPY tests tests
RUN mkdir -p /app/node_modules/.vite-temp && chown 1000:1000 /app/node_modules/.vite-temp
USER 1000:1000
ENV HOME=/tmp
CMD ["npm", "test"]

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PLAYDOT_MODE=locked
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
COPY scripts/check-provider.mjs ./scripts/check-provider.mjs
COPY scripts/verify-oauth-setup.mjs ./scripts/verify-oauth-setup.mjs
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/ready',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/apps/server/src/main.js"]
