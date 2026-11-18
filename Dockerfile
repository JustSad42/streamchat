# StreamChat server for Linux (e.g. a Hetzner VPS). Node runs the TypeScript directly.
FROM node:24-alpine
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server/src ./src
COPY web /app/web
ENV HOST=0.0.0.0 \
    PORT=8787 \
    WEBHOOK_PORT=8788 \
    STREAMCHAT_DATA=/data \
    NODE_ENV=production
VOLUME /data
EXPOSE 8787 8788
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["node", "src/main.ts"]
