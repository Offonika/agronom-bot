FROM node:18
WORKDIR /usr/src/app
COPY bot/package*.json ./bot/
RUN npm ci --prefix bot
COPY . .
ENTRYPOINT ["node", "bot/index.js"]
