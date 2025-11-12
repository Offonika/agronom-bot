FROM node:20
WORKDIR /usr/src/app

# Ensure modules installed here are visible to shared code in /usr/src
ENV NODE_PATH=/usr/src/app/node_modules

# Install dependencies using bot package manifests
COPY bot/package*.json ./
RUN npm ci

# Copy bot sources
COPY bot/ .
# Include shared localization files
COPY locales ./locales
# Include shared JS services used by the bot (keep path consistent with ../services import)
COPY services /usr/src/services

ENTRYPOINT ["node", "index.js"]
