FROM node:20-bullseye-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    MCP_SERVER_PORT=3000 \
    LOG_LEVEL=info \
    TOOLS_DB_PATH=/app/data/tools_vector.db

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "mcp-server.js"]
