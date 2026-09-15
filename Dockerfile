# Xacheus AI — always-on deployment.
#
# Use this when you want the *whole* platform: live WebSocket streaming to the
# console, a persistent device socket for the Android app, and the in-process
# automation scheduler. Serverless hosting cannot offer those (see DEPLOY.md),
# which is why this file exists.
#
#   docker build -t xacheus .
#   docker run -p 8787:8787 --env-file .env -v xacheus-data:/data xacheus
#
# Build stage: compile the kernel, server and console.
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --include=dev

COPY . .
RUN npm run build

# Runtime stage: production dependencies only.
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    XACHEUS_DATA_DIR=/data

COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/dist dist

# Data lives on a volume: memory, business records, knowledge index, audit log.
VOLUME ["/data"]
EXPOSE 8787

# The server has no dependency on root privileges.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/server/dist/index.js"]
