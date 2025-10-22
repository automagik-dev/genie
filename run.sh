#!/usr/bin/env bash
# Genie - One command to rule them all
set -e

# 1. Ensure Node.js exists
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    if [ ! -d "$HOME/.nvm" ]; then
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
    fi
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm install 22
    nvm use 22
fi

# 2. Ensure pnpm exists (speed!)
if ! command -v pnpm &> /dev/null; then
    echo "Installing pnpm..."
    npm install -g pnpm
fi

# 3. Run Genie (use global if available, otherwise dlx)
if command -v genie &> /dev/null; then
    exec genie "$@"
else
    exec pnpm dlx automagik-genie@next "$@"
fi
