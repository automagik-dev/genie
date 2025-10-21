#!/usr/bin/env bash

# Genie Installation Script for Linux/Mac
# Installs dependencies (npm, pnpm) and sets up Genie

set -e  # Exit on error

echo "🧞 Genie Installation Wizard"
echo "============================="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

# Function to show template menu with descriptions
select_template() {
    echo ""
    echo "📋 Choose Your Template"
    echo "━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  1. 💻 code"
    echo "     Full-stack development with Git, testing, CI/CD"
    echo "     Agents: install, wish, forge, review, implementor, tests"
    echo ""
    echo "  2. ✍️  create"
    echo "     Research, writing, content creation"
    echo "     Agents: install, wish, writer, researcher, editor"
    echo ""
    read -p "Select template [1]: " choice
    choice=${choice:-1}

    if [ "$choice" = "2" ]; then
        echo "create"
    else
        echo "code"
    fi
}

# Step 1: Check if npm is installed
echo "Step 1: Checking for npm..."
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm -v)
    print_success "npm is already installed (version $NPM_VERSION)"
else
    print_warning "npm not found. Installing Node.js via nvm..."

    # Check if nvm is installed
    if [ ! -d "$HOME/.nvm" ]; then
        echo "Installing nvm..."
        curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

        # Load nvm without restarting shell
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

        print_success "nvm installed"
    else
        print_success "nvm already installed"
        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    fi

    # Install Node.js 22
    echo "Installing Node.js 22..."
    nvm install 22
    nvm use 22

    # Verify installation
    NODE_VERSION=$(node -v)
    NPM_VERSION=$(npm -v)
    print_success "Node.js installed: $NODE_VERSION"
    print_success "npm installed: $NPM_VERSION"
fi

echo ""

# Step 2: Check if pnpm is installed
echo "Step 2: Checking for pnpm..."
if command -v pnpm &> /dev/null; then
    PNPM_VERSION=$(pnpm -v)
    print_success "pnpm is already installed (version $PNPM_VERSION)"
else
    print_warning "pnpm not found. Installing pnpm..."
    npm install -g pnpm
    PNPM_VERSION=$(pnpm -v)
    print_success "pnpm installed (version $PNPM_VERSION)"
fi

echo ""

# Step 3: Install Genie globally
echo "Step 3: Installing Genie..."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Installing Genie globally"
echo "  ✓ Use 'genie' command from anywhere"
echo "  ✓ Faster startup (no download each time)"
echo "  ✓ Auto-update checks"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

pnpm install -g automagik-genie@next
print_success "Genie installed globally!"

echo ""

# Step 4: Initialize workspace
echo "Step 4: Initialize Genie workspace..."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Initialize Genie workspace in this directory?"
echo "  This will create .genie/ with agents and workflows"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
read -p "Initialize workspace? [Y/n]: " init_workspace
init_workspace=${init_workspace:-Y}

if [[ "$init_workspace" =~ ^[Yy]$ ]]; then
    template=$(select_template)
    echo ""
    echo "🚀 Initializing Genie with '$template' template..."
    echo ""

    genie init $template

    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅ Setup complete!"
    echo ""
    echo "  Next steps:"
    echo "    • Run: genie"
    echo "    • Or configure Claude Code MCP:"
    echo "      npx automagik-genie mcp -t stdio"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
    echo ""
    print_success "Genie installed! Run 'genie init <template>' when ready."
    echo ""
    echo "  Templates:"
    echo "    • genie init code    - Development template"
    echo "    • genie init create  - Content creation template"
fi
