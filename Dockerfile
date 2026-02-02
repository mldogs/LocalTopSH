FROM node:22-slim

# Install tools + python with pip
RUN apt-get update && apt-get install -y \
    git curl grep \
    python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/lib/python*/EXTERNALLY-MANAGED

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN mkdir -p /workspace
ENV AGENT_CWD=/workspace

CMD ["npx", "tsx", "src/index.ts"]
