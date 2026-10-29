# Single-container deployment (any VPS, Coolify, Fly, Railway...): API + dashboard + agent jobs
# in one Node process, data persisted to a JSON file on a mounted volume.
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
ENV NODE_ENV=production \
    DB=memory \
    LOCAL_DB_FILE=/data/db.json \
    LOCAL_ASSETS_DIR=/data/assets \
    PORT=8787
VOLUME ["/data"]
EXPOSE 8787
# Secrets via env: META_API_KEY, ADMIN_TOKEN, THREADS_TOKEN, OPEN_WEIGHTS_BASE_URL, OPEN_WEIGHTS_API_KEY
CMD ["node", "scripts/dev-server.mjs"]
