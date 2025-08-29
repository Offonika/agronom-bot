FROM node:20
WORKDIR /usr/src/app

# Install dependencies using bot package manifests
COPY bot/package*.json ./
RUN npm ci

# Copy bot sources
COPY bot/ .
# Include shared localization files
COPY locales ./locales

ENTRYPOINT ["node", "index.js"]
