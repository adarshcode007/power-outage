FROM node:22-bookworm-slim

WORKDIR /app
ENV CI=true

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

CMD ["npm", "run", "dev"]
