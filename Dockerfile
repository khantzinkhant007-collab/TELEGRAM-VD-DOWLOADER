# syntax=docker/dockerfile:1
# =============================================================================
# Stage 1: Production Dependencies
# =============================================================================
FROM node:20-alpine AS deps

WORKDIR /app

# Install only production dependencies cleanly
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts && npm cache clean --force; \
    else \
      npm install --omit=dev --ignore-scripts && npm cache clean --force; \
    fi

# =============================================================================
# Stage 2: Hardened Production Runtime (AWS App Runner / ECS Fargate / Docker)
# =============================================================================
FROM node:20-alpine AS runner

LABEL org.opencontainers.image.title="Telegram Video Batch Downloader" \
      org.opencontainers.image.description="Full-stack Telegram multi-video batch downloader service" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# Copy production node_modules and application source with non-root ownership
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node api ./api

# Drop privileges to built-in non-root user
USER node

EXPOSE 3000

# Container healthcheck probing GET /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http = require('http'); const port = process.env.PORT || 3000; const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 4000 }, (res) => { process.exit(res.statusCode === 200 ? 0 : 1); }); req.on('error', () => process.exit(1)); req.end();"

CMD ["node", "server.js"]
