FROM node:20
WORKDIR /usr/src/app

ENV NODE_PATH=/usr/src/app/node_modules

COPY package*.json ./
RUN npm ci

COPY worker ./worker
COPY services ./services
COPY locales ./locales

ENTRYPOINT ["node", "worker/autoplan.js"]
