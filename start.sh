#!/usr/bin/env bash
# 🧞 Genie - Your wish is my command ✨
set -e

echo ""
echo "🧞 ✨ Summoning Genie..."
echo ""

# 1. Ensure Node.js exists
if ! command -v node &> /dev/null; then
    echo "📦 Preparing magik ingredients (Node.js)..."
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
    echo "⚡ Enchanting package manager (pnpm)..."

    # Set up user-local directory for package managers
    export PNPM_HOME="$HOME/.local/share/pnpm"

    # Create directory if it doesn't exist
    mkdir -p "$PNPM_HOME"

    # Always use npm with user prefix (most reliable, no sudo needed)
    npm install -g pnpm --prefix="$HOME/.local"

    # Add both possible locations to PATH
    export PATH="$HOME/.local/bin:$PNPM_HOME:$PATH"

    # Add to shell profile for persistence (only if not already there)
    # This is optional - script will work without it (just need to restart shell)
    for profile in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$profile" ] && [ -w "$profile" ]; then
            if ! grep -q "PNPM_HOME" "$profile" 2>/dev/null; then
                {
                    echo ''
                    echo '# pnpm configuration (added by Genie installer)'
                    echo 'export PNPM_HOME="$HOME/.local/share/pnpm"'
                    echo 'export PATH="$HOME/.local/bin:$PNPM_HOME:$PATH"'
                } >> "$profile" 2>/dev/null || true
            fi
        fi
    done

    # Verify pnpm is available
    if ! command -v pnpm &> /dev/null; then
        echo "⚠️  Hmm, pnpm installed but not in PATH. Run this spell:"
        echo "    export PATH=\"$HOME/.local/bin:$PNPM_HOME:\$PATH\""
        exit 1
    fi
fi

# 3. Check for updates and install/update Genie
if command -v genie &> /dev/null; then
    # Get installed version
    INSTALLED_VERSION=$(genie --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?' || echo "0.0.0")

    # Get latest @next version from npm (silent, fast)
    LATEST_VERSION=$(npm view automagik-genie@next version 2>/dev/null || echo "$INSTALLED_VERSION")

    # Compare versions
    if [ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]; then
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🧞 ✨ NEW MAGIK AVAILABLE ✨"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "Current spell: $INSTALLED_VERSION"
        echo "New spell:     $LATEST_VERSION"
        echo ""
        echo "⚡ Upgrading your powers..."
        pnpm install -g automagik-genie@next
        echo ""
        echo "✅ You're now running v$LATEST_VERSION! ✨"
        echo ""
    fi
else
    # Not installed - install it globally first
    echo "🎩 Pulling Genie from the lamp..."
    pnpm install -g automagik-genie@next
    echo ""
    echo "✅ Genie is ready to grant your wishes! ✨"
    echo ""
fi

# 4. Launch Genie - use exec to replace this shell process
echo "🧞 Your wish is my command..."
echo ""
if [ $# -eq 0 ]; then
    exec genie
else
    # Arguments provided - pass through
    exec genie "$@"
fi
