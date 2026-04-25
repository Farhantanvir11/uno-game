# Use Node 20 with build tools available (better-sqlite3 needs node-gyp).
FROM node:20-bookworm-slim AS deps

# Install build deps for native modules (better-sqlite3).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- Runtime ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

# Copy node_modules + app source.
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Persistent volume mount target. DATA_DIR is read by db.js.
ENV NODE_ENV=production
ENV DATA_DIR=/var/data
ENV PORT=8080

EXPOSE 8080
CMD ["npm", "start"]
