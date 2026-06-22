# Sentinel backend — production image (Sui Testnet only).
# Build context is the REPO ROOT (see docker-compose.prod.yml) so the backend's
# tsconfig can extend ../tsconfig.base.json. The repo layout is mirrored under
# /app: /app/tsconfig.base.json + /app/backend/*.
# Multi-stage: compile TypeScript -> dist, then run a slim runtime with only
# production deps. Migrations/seed run from compiled JS (node dist/...), so no
# dev toolchain is needed at runtime.

# ---------- build stage ----------
FROM node:20-alpine AS build
WORKDIR /app

# Workspace base tsconfig the backend config extends.
COPY tsconfig.base.json ./tsconfig.base.json

# Install all deps (incl. dev) using only the manifest for better layer caching.
COPY backend/package.json ./backend/package.json
RUN cd backend && npm install

# Compile the TypeScript sources to backend/dist/.
COPY backend/tsconfig.json ./backend/tsconfig.json
COPY backend/src ./backend/src
RUN cd backend && npm run build

# Drop dev dependencies so we copy a lean node_modules into the runtime image.
RUN cd backend && npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:20-alpine
WORKDIR /app/backend
ENV NODE_ENV=production

# Compiled app + production deps + the SQL migrations the runner reads.
COPY --from=build /app/backend/node_modules ./node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/package.json ./package.json
COPY backend/migrations ./migrations

# REST API + WebSocket server.
EXPOSE 4000

CMD ["node", "dist/index.js"]
