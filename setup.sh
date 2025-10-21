#!/usr/bin/env bash

# Genie Installation Script for Linux/Mac
# This script installs npm, pnpm, and runs Genie

set -e  # Exit on error

echo "🧞 Genie Installation Script"
echo "============================"
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

# Step 3: Run Genie
echo "Step 3: Launching Genie..."
echo ""
echo "Choose template:"
echo "  1. code   - Software development (full-stack, testing, git)"
echo "  2. create - Research, writing, planning (self-adaptive AI)"
echo ""
read -p "Template [1]: " template_choice
template_choice=${template_choice:-1}

if [ "$template_choice" = "2" ]; then
    print_success "Running: pnpm dlx automagik-genie@next init create"
    echo ""
    pnpm dlx automagik-genie@next init create
else
    print_success "Running: pnpm dlx automagik-genie@next init code"
    echo ""
    pnpm dlx automagik-genie@next init code
fi
