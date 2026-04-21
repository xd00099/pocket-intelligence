FROM node:20-slim

# Install system dependencies: git, zsh, curl for Claude Code + python3/make/g++ for node-pty
RUN apt-get update && \
    apt-get install -y git zsh curl python3 make g++ ca-certificates \
    libreoffice-impress libreoffice-writer libreoffice-calc \
    poppler-utils && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/
COPY skills/ ./skills/
RUN npx tsc

# Persist Claude Code config and sessions on the volume
ENV HOME=/workspace/.home
ENV WORKSPACE_DIR=/workspace
ENV PORT=3000

EXPOSE 3000

COPY startup.sh ./
RUN chmod +x startup.sh

CMD ["./startup.sh"]
