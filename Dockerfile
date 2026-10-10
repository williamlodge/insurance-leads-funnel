FROM node:20-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
# better-sqlite3 needs build tools for native compilation on alpine
RUN apk add --no-cache python3 make g++ \
    && npm install --omit=dev \
    && apk del python3 make g++

COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
