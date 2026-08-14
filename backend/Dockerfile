FROM node:22-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 ca-certificates \
    && ln -sf /usr/bin/python3 /usr/local/bin/python \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

EXPOSE 8080

CMD ["node", "server.js"]
