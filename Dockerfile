#syntax=docker/dockerfile:1

# Single image used by both the `app` service (serves API + built React bundle)
# and the one-shot `verify` service (tests + build + HTTP smoke).
FROM node:20-bookworm-slim

WORKDIR /app

# Install workspace dependencies first for better layer caching.
COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
RUN npm install --no-audit --no-fund

# Copy sources and build the React bundle (the Node server hosts web/dist).
COPY . .
RUN npm run build

ENV HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080

CMD ["node", "server/src/server.js"]
