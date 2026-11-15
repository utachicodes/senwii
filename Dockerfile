# Runs behind a platform's own TLS-terminating edge (Fly.io, Render, Railway,
# a reverse proxy) — see TRUST_PROXY in server.js and README's "Running
# online" section. Not meant for LAN play: for that, run `npm start` on bare
# metal, since it needs the host's real network interfaces for the LAN IP
# scan and the self-signed cert that a container can't usefully provide.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV TRUST_PROXY=1
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
