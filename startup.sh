#!/bin/sh
set -e

# Ensure HOME directory exists
mkdir -p "$HOME/.claude/skills"

# Install skills
cp -r /app/skills/* "$HOME/.claude/skills/"

# Configure git credentials if GITHUB_TOKEN is set
if [ -n "$GITHUB_TOKEN" ]; then
  git config --global credential.helper store
  echo "https://x-access-token:${GITHUB_TOKEN}@github.com" > "$HOME/.git-credentials"
  git config --global user.email "${GIT_USER_EMAIL:-claude-sandbox@noreply}"
  git config --global user.name "${GIT_USER_NAME:-Claude Sandbox}"
fi

# Start the server
exec node dist/server.js
