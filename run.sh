#!/usr/bin/env bash

# Genie Smart Run Script
# Detects context and guides user through appropriate workflow

set -e

echo "🧞 Genie Smart Run"
echo "=================="
echo ""

# Case 1: Check if .genie folder exists
if [ -d ".genie" ]; then
    echo "✅ Found .genie workspace in current directory"
    echo ""

    # Check if Genie/Forge is already running
    if lsof -Pi :8887 -sTCP:LISTEN -t >/dev/null 2>&1; then
        PID=$(lsof -Pi :8887 -sTCP:LISTEN -t 2>/dev/null | head -1)
        echo "⚠️  Genie server already running (PID: $PID, Port: 8887)"
        echo ""
        echo "Options:"
        echo "  1. Connect to existing server (recommended)"
        echo "  2. Stop and restart"
        echo ""
        read -p "Choice [1]: " choice
        choice=${choice:-1}

        if [ "$choice" = "2" ]; then
            echo "Stopping existing server..."
            kill $PID 2>/dev/null || true
            sleep 2
        else
            echo "Using existing server at http://localhost:8887"
            echo ""
            echo "💡 MCP already available!"
            echo "   Configure Claude Code: npx automagik-genie mcp -t stdio"
            exit 0
        fi
    fi

    # Check if genie is installed globally
    if command -v genie &> /dev/null; then
        echo "Using globally installed genie..."
        genie
    else
        echo "Running via pnpm dlx..."
        pnpm dlx automagik-genie@next
    fi
else
    # Case 2: No .genie folder - fresh user
    echo "📂 No .genie workspace found"
    echo ""
    echo "💡 To use Genie in this directory:"
    echo ""
    echo "   Option 1: Install globally (recommended)"
    echo "   $ pnpm install -g automagik-genie@next"
    echo "   $ genie init"
    echo ""
    echo "   Option 2: Quick test without install"
    echo "   $ pnpm dlx automagik-genie@next init"
    echo ""
    read -p "Install Genie globally? [y/N]: " install

    if [[ "$install" =~ ^[Yy]$ ]]; then
        echo ""
        echo "Installing Genie globally..."
        pnpm install -g automagik-genie@next
        echo ""
        echo "✅ Genie installed!"
        echo ""
        read -p "Initialize .genie workspace in current directory? [Y/n]: " init
        init=${init:-Y}

        if [[ "$init" =~ ^[Yy]$ ]]; then
            echo ""
            genie init
        else
            echo ""
            echo "💡 Run 'genie init' when ready to set up this project"
        fi
    else
        echo ""
        echo "Running quick test via pnpm dlx..."
        pnpm dlx automagik-genie@next init
    fi
fi

# Offer permanent installation reminder
if ! command -v genie &> /dev/null; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "💡 Want to install Genie permanently?"
    echo "   Run: pnpm install -g automagik-genie@next"
    echo ""
    echo "   Then use 'genie' command from anywhere!"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
fi
