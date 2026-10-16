FROM node:22-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=7575 DATA_DIR=/app/data NODE_ENV=production
VOLUME /app/data
EXPOSE 7575
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:7575/api/health || exit 1
CMD ["node","server.js"]
