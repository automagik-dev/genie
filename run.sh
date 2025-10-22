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

# 3. Check for updates and run Genie
if command -v genie &> /dev/null; then
    # Get installed version
    INSTALLED_VERSION=$(genie --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?' || echo "0.0.0")

    # Get latest @next version from npm (silent, fast)
    LATEST_VERSION=$(npm view automagik-genie@next version 2>/dev/null || echo "$INSTALLED_VERSION")

    # Compare versions
    if [ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]; then
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🧞 ✨ UPDATE AVAILABLE"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "Installed: $INSTALLED_VERSION"
        echo "Latest:    $LATEST_VERSION"
        echo ""
        echo "Updating Genie..."
        pnpm install -g automagik-genie@next
        echo ""
        echo "✅ Updated to $LATEST_VERSION"
        echo ""
    fi
    exec genie "$@"
else
    # Not installed - use dlx (auto-downloads latest)
    exec pnpm dlx automagik-genie@next "$@"
fi
