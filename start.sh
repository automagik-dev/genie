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

    # Set up user-local directory for package managers
    export PNPM_HOME="$HOME/.local/share/pnpm"
    export PATH="$PNPM_HOME:$PATH"

    # Create directory if it doesn't exist
    mkdir -p "$PNPM_HOME"

    # Try corepack with user-local directory (no sudo needed)
    if command -v corepack &> /dev/null; then
        # Set corepack to install to user directory
        export COREPACK_HOME="$HOME/.local/share/corepack"
        mkdir -p "$COREPACK_HOME"

        # Try to use corepack without system-wide enable
        if corepack prepare pnpm@latest --activate 2>/dev/null; then
            # Success with corepack
            :
        else
            # Corepack failed, fall back to npm
            npm install -g pnpm --prefix="$HOME/.local"
        fi
    else
        # No corepack, use npm with user prefix
        npm install -g pnpm --prefix="$HOME/.local"
    fi

    # Add to shell profile for persistence (only if not already there)
    # This is optional - script will work without it (just need to restart shell)
    for profile in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$profile" ] && [ -w "$profile" ]; then
            if ! grep -q "PNPM_HOME" "$profile" 2>/dev/null; then
                {
                    echo ''
                    echo '# pnpm configuration (added by Genie installer)'
                    echo 'export PNPM_HOME="$HOME/.local/share/pnpm"'
                    echo 'export PATH="$PNPM_HOME:$PATH"'
                } >> "$profile" 2>/dev/null || true
            fi
        fi
    done

    # Verify pnpm is available
    if ! command -v pnpm &> /dev/null; then
        echo "⚠️  pnpm installed but not in PATH. Run this command:"
        echo "    export PATH=\"$PNPM_HOME:\$PATH\""
    fi
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
