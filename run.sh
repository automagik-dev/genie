#!/usr/bin/env bash

# Genie Smart Run Script
# One-command setup: checks for updates, installs globally, initializes workspace

set -e

echo "🧞 Genie Smart Launcher"
echo "======================="
echo ""

# Function to check for updates
check_for_updates() {
    if command -v genie &> /dev/null; then
        echo "🔍 Checking for updates..."
        CURRENT_VERSION=$(genie --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-.+)?' || echo "unknown")
        LATEST_VERSION=$(npm view automagik-genie@next version 2>/dev/null || echo "unknown")

        if [ "$CURRENT_VERSION" != "$LATEST_VERSION" ] && [ "$LATEST_VERSION" != "unknown" ]; then
            echo "📦 Update available: $CURRENT_VERSION → $LATEST_VERSION"
            echo ""
            read -p "Update to latest version? [Y/n]: " update
            update=${update:-Y}

            if [[ "$update" =~ ^[Yy]$ ]]; then
                echo ""
                echo "⬆️  Updating Genie..."
                pnpm install -g automagik-genie@next
                echo "✅ Updated to $LATEST_VERSION"
                echo ""
            fi
        else
            echo "✅ You're on the latest version ($CURRENT_VERSION)"
            echo ""
        fi
    fi
}

# Function to show template menu with descriptions
select_template() {
    echo "📋 Choose Your Template" >&2
    echo "━━━━━━━━━━━━━━━━━━━━━━" >&2
    echo "" >&2
    echo "  1. 💻 code" >&2
    echo "     Full-stack development with Git, testing, CI/CD" >&2
    echo "     Agents: install, wish, forge, review, implementor, tests" >&2
    echo "" >&2
    echo "  2. ✍️  create" >&2
    echo "     Research, writing, content creation" >&2
    echo "     Agents: install, wish, writer, researcher, editor" >&2
    echo "" >&2
    read -p "Select template [1]: " choice
    choice=${choice:-1}

    if [ "$choice" = "2" ]; then
        echo "create"
    else
        echo "code"
    fi
}

# Check if .genie workspace exists
if [ -d ".genie" ]; then
    echo "✅ Found .genie workspace"
    echo ""

    # Check for updates
    check_for_updates

    # Check if Forge is already running
    if lsof -Pi :8887 -sTCP:LISTEN -t >/dev/null 2>&1; then
        PID=$(lsof -Pi :8887 -sTCP:LISTEN -t 2>/dev/null | head -1)
        echo "⚠️  Genie server running (PID: $PID, Port: 8887)"
        echo ""
        read -p "Restart server? [y/N]: " restart

        if [[ "$restart" =~ ^[Yy]$ ]]; then
            echo "Restarting server..."
            kill $PID 2>/dev/null || true
            sleep 2
        else
            echo "Using existing server at http://localhost:8887"
            exit 0
        fi
    fi

    # Run genie
    if command -v genie &> /dev/null; then
        genie
    else
        echo "⚠️  Global genie not found, running via pnpm dlx..."
        pnpm dlx automagik-genie@next
    fi
else
    # No .genie workspace - first-time setup
    echo "📂 No .genie workspace found"
    echo ""

    # Check if globally installed
    if ! command -v genie &> /dev/null; then
        echo "💡 Genie is not installed globally"
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "  Recommended: Install Genie globally"
        echo "  ✓ Use 'genie' command from anywhere"
        echo "  ✓ Faster startup (no download each time)"
        echo "  ✓ Auto-update checks"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        read -p "Install Genie globally now? [Y/n]: " install_global
        install_global=${install_global:-Y}

        if [[ "$install_global" =~ ^[Yy]$ ]]; then
            echo ""
            echo "📦 Installing Genie globally..."
            pnpm install -g automagik-genie@next
            echo ""
            echo "✅ Genie installed globally!"
            echo ""
        fi
    else
        # Already installed, check for updates
        check_for_updates
    fi

    # Ask if user wants to initialize workspace
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Initialize Genie workspace in this directory?"
    echo "  This will create .genie/ with agents and workflows"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    read -p "Initialize workspace? [Y/n]: " init_workspace
    init_workspace=${init_workspace:-Y}

    if [[ "$init_workspace" =~ ^[Yy]$ ]]; then
        echo ""
        echo "🚀 Starting Genie initialization..."
        echo ""

        # Run genie init (will use Ink wizard)
        if command -v genie &> /dev/null; then
            genie init
        else
            pnpm dlx automagik-genie@next init
        fi

        # After init completes, automatically start genie server
        if [ $? -eq 0 ]; then
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "  ✅ Installation complete!"
            echo "  🚀 Starting Genie server..."
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""

            if command -v genie &> /dev/null; then
                exec genie
            else
                exec pnpm dlx automagik-genie@next
            fi
        else
            echo ""
            echo "❌ Initialization failed. Please check the errors above."
            exit 1
        fi
    else
        echo ""
        echo "💡 Run './run.sh' anytime to set up your workspace"
    fi
fi
