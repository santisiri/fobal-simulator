# FOBAL match server — build from the REPO ROOT so the golden reference and
# workspace packages are in the context:
#
#   docker build -f apps/match-server/Dockerfile -t fobal-staging-match-server .
#
# The engine executes the golden simulation source extracted from index.html
# at load time (packages/engine/src/goldenRuntime.ts), and every package runs
# TypeScript directly via tsx — so the image ships workspace sources plus
# index.html, not a compiled bundle. Staging runs x86_64
# (infra/cdk/lib/fobal-staging-stack.ts): build with --platform linux/amd64
# when producing the ECR image on an ARM host.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/engine/package.json packages/engine/
COPY apps/match-server/package.json apps/match-server/
COPY apps/match-client/package.json apps/match-client/
COPY apps/lobby-server/package.json apps/lobby-server/
RUN npm ci --omit=dev --ignore-scripts

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8473 \
    FOBAL_STORE=/data/matches
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json index.html ./
COPY packages/protocol ./packages/protocol
COPY packages/engine ./packages/engine
COPY apps/match-server ./apps/match-server
# the lobby (B1/B4) ships in the SAME image and runs as a second ECS service
# with a command override:
#   node_modules/.bin/tsx apps/lobby-server/src/index.ts
COPY apps/lobby-server ./apps/lobby-server
RUN mkdir -p /data/matches /data/lobby && chown -R node:node /data
USER node
EXPOSE 8473
# mirrors the ECS container health check for local docker runs
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8473)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "apps/match-server/src/index.ts"]
