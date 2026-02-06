FROM node:22-bookworm

# Install additional tools (grep, sed already in base image)
RUN apt-get update && apt-get install -y \
    git curl wget gawk \
    python3 python3-pip python3-venv \
    build-essential cmake \
    jq htop tree ripgrep fd-find \
    zip unzip tar \
    iproute2 net-tools lsof \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /usr/lib/python*/EXTERNALLY-MANAGED \
    && ln -sf /usr/bin/fdfind /usr/bin/fd

# Create non-root user for security
RUN groupadd -r agent && useradd -r -g agent -d /home/agent -s /bin/bash agent \
    && mkdir -p /home/agent && chown -R agent:agent /home/agent

# Pre-install common Python packages for web servers
RUN pip install --break-system-packages flask fastapi uvicorn requests

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

# Create workspace with proper permissions
RUN mkdir -p /workspace && chown -R agent:agent /workspace
RUN chown -R agent:agent /app

ENV AGENT_CWD=/workspace

CMD ["npx", "tsx", "src/index.ts"]
