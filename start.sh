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
        echo "⚠️  pnpm installed but not in PATH. Run this command:"
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
else
    # Not installed - install it globally first
    echo "Installing Genie..."
    pnpm install -g automagik-genie@next
fi

# 4. If no arguments, run interactive setup
if [ $# -eq 0 ]; then
    # Check if already initialized
    if [ ! -f ".genie/state/version.json" ]; then
        # First time setup - run init, then launch install agent
        echo ""
        echo "Running Genie initialization..."
        echo ""
        genie init

        # After init completes, detect template and launch install agent
        # Use exec to replace this script with genie (gives it fresh stdin)
        echo ""
        echo "✅ Setup complete! Launching Genie install agent..."
        echo ""

        # Detect template from .genie structure
        if [ -d ".genie/code" ]; then
            TEMPLATE="code"
        elif [ -d ".genie/create" ]; then
            TEMPLATE="create"
        else
            TEMPLATE="code"  # fallback
        fi

        # Replace this script with genie run (interactive install agent gets fresh stdin)
        exec genie run "${TEMPLATE}/install" "Use the install subagent to set up Genie in this repo."
    else
        # Already initialized - just run genie
        exec genie
    fi
else
    # Arguments provided - pass through to genie
    exec genie "$@"
fi
