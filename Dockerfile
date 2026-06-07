# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine

# Netzwerk-Tools für ARP/Ping/Gateway-Erkennung
RUN apk add --no-cache \
    iputils \
    iproute2

WORKDIR /app

# Nur Produktions-Dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Server-Code
COPY server ./server

# Kompiliertes Frontend
COPY --from=builder /app/dist ./dist

# Daten-Verzeichnis für Cache + Credentials
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=80
ENV DATA_DIR=/app/data

EXPOSE 80

CMD ["node", "server/index.js"]
