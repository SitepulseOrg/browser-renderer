FROM node:24-bookworm-slim

WORKDIR /home/node/app

ENV PUPPETEER_CACHE_DIR=/home/node/.cache/puppeteer
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && apt-get update \
    && npx puppeteer browsers install chrome --install-deps \
    && chown -R node:node /home/node/.cache

COPY --chown=node:node server.js browser-tasks.js ./

ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "server.js"]
