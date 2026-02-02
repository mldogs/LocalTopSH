FROM node:22-slim

RUN apt-get update && apt-get install -y git curl grep python3 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /workspace
ENV AGENT_CWD=/workspace

CMD ["npx", "tsx", "src/index.ts"]
