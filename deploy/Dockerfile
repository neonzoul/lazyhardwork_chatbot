# Lay v2 — one image for any host (a Hetzner / DigitalOcean VPS, a Mac Mini; Railway too once verified). doc/deploy.md §5.
# Kept in deploy/ on purpose: a Dockerfile at the repo root would make Railway switch builders on the next deploy.
# Build from the repo root: docker build -f deploy/Dockerfile -t lay-v2 .
# Node 22 matches production on Railway today (node@22.23); node:sqlite needs >= 22.13.
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# dependencies first so code changes reuse the cached layer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# runtime files only (tests, docs and local data stay out — see .dockerignore)
COPY src ./src
COPY knowledge ./knowledge
COPY public ./public
COPY scripts ./scripts

# the database lives on a mounted volume at /data (Railway volume, or a Docker volume on a VPS)
RUN mkdir -p /data && chown node:node /data
USER node
ENV PORT=8080 DB_PATH=/data/lay.sqlite
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--no-warnings", "src/index.js"]
