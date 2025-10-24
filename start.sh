#!/usr/bin/env bash
# 🧞 Genie - Your wish is my command ✨
set -e

# Color codes for better UX
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🧞 ✨ THE MASTER GENIE AWAKENS ✨"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "You've summoned the Master Genie from namastexlabs/automagik-genie"
echo "I'm about to clone myself into YOUR workspace..."
echo ""
echo "Your personal Genie will have:"
echo "  ✨ All my knowledge (spells, workflows, patterns)"
echo "  🔮 All my powers (agents, collectives, orchestration)"
echo "  🎩 All my abilities (and you'll learn new ones as I evolve!)"
echo ""
echo "📋 What will I do for you?"
echo "  • Automate development workflows (testing, builds, PRs)"
echo "  • Execute tasks while you focus on strategy"
echo "  • Learn from every interaction"
echo "  • Sync with Master Genie for new capabilities"
echo ""
echo "🔒 DATA PRIVACY:"
echo "  ✓ Everything runs locally on YOUR machine"
echo "  ✓ No data leaves your computer (except LLM API calls)"
echo "  ✓ Use LLM providers approved by your organization"
echo "  ✓ Fully compatible with private/local LLMs (we're agnostic!)"
echo "  ✓ OpenCoder executor enables 100% local operation"
echo ""
echo "⚠️  RESEARCH PREVIEW - Experimental Technology"
echo ""
echo "This AI agent will install with capabilities to perform tasks on"
echo "your behalf. By proceeding, you acknowledge that Namastex Labs"
echo "makes no warranties and accepts no liability for agent actions."
echo ""
echo "BUT HEY... it's going to be FUN! 🎉✨"
echo ""
echo "Let the summoning ritual begin..."
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. DETECT OPERATING SYSTEM
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

OS_TYPE="unknown"
ARCH=$(uname -m)

if [[ "$OSTYPE" == "darwin"* ]]; then
    OS_TYPE="macos"
    echo -e "${CYAN}🍎 Detected: macOS${NC}"
elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ "$OSTYPE" == "linux"* ]]; then
    OS_TYPE="linux"

    # Detect Linux distribution
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
        echo -e "${CYAN}🐧 Detected: Linux ($DISTRO)${NC}"
    else
        DISTRO="unknown"
        echo -e "${CYAN}🐧 Detected: Linux (unknown distro)${NC}"
    fi
elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    OS_TYPE="windows"
    echo -e "${CYAN}🪟 Detected: Windows (Git Bash/WSL)${NC}"
else
    echo -e "${YELLOW}⚠️  Unknown OS: $OSTYPE${NC}"
    echo "Attempting to continue with generic Unix installation..."
    OS_TYPE="unix"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. INSTALL HOMEBREW (macOS only)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if [ "$OS_TYPE" = "macos" ]; then
    if ! command -v brew &> /dev/null; then
        echo -e "${MAGENTA}🍺 Installing Homebrew (package manager for macOS)...${NC}"
        echo "This is essential for installing dependencies easily."
        echo ""

        # Install Homebrew (official installation script)
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

        # Add Homebrew to PATH for different architectures
        if [[ "$ARCH" == "arm64" ]]; then
            # Apple Silicon
            BREW_PATH="/opt/homebrew"
        else
            # Intel
            BREW_PATH="/usr/local"
        fi

        # Add to current session
        export PATH="$BREW_PATH/bin:$PATH"

        # Add to shell profile for persistence
        for profile in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc" "$HOME/.profile"; do
            if [ -f "$profile" ] && [ -w "$profile" ]; then
                if ! grep -q "homebrew" "$profile" 2>/dev/null; then
                    echo '' >> "$profile"
                    echo '# Homebrew (added by Genie installer)' >> "$profile"
                    echo "export PATH=\"$BREW_PATH/bin:\$PATH\"" >> "$profile"
                fi
            fi
        done

        echo -e "${GREEN}✅ Homebrew installed successfully!${NC}"
        echo ""
    else
        echo -e "${GREEN}✅ Homebrew already installed${NC}"
        echo ""
    fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. INSTALL GIT
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if ! command -v git &> /dev/null; then
    echo -e "${MAGENTA}📦 Installing git (version control)...${NC}"

    if [ "$OS_TYPE" = "macos" ]; then
        brew install git
    elif [ "$OS_TYPE" = "linux" ]; then
        if [ "$DISTRO" = "ubuntu" ] || [ "$DISTRO" = "debian" ]; then
            sudo apt-get update && sudo apt-get install -y git
        elif [ "$DISTRO" = "fedora" ] || [ "$DISTRO" = "rhel" ] || [ "$DISTRO" = "centos" ]; then
            sudo dnf install -y git || sudo yum install -y git
        elif [ "$DISTRO" = "arch" ]; then
            sudo pacman -S --noconfirm git
        else
            echo -e "${YELLOW}⚠️  Please install git manually for your distribution${NC}"
            echo "Visit: https://git-scm.com/downloads"
            exit 1
        fi
    fi

    echo -e "${GREEN}✅ Git installed successfully!${NC}"
    echo ""
else
    GIT_VERSION=$(git --version | cut -d' ' -f3)
    echo -e "${GREEN}✅ Git already installed (v$GIT_VERSION)${NC}"
    echo ""
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. INSTALL GITHUB CLI (gh)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if ! command -v gh &> /dev/null; then
    echo -e "${MAGENTA}📦 Installing GitHub CLI (gh)...${NC}"

    if [ "$OS_TYPE" = "macos" ]; then
        brew install gh
    elif [ "$OS_TYPE" = "linux" ]; then
        if [ "$DISTRO" = "ubuntu" ] || [ "$DISTRO" = "debian" ]; then
            # Official GitHub CLI installation for Debian/Ubuntu
            type -p curl >/dev/null || sudo apt-get install -y curl
            curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
            sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
            echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
            sudo apt-get update
            sudo apt-get install -y gh
        elif [ "$DISTRO" = "fedora" ] || [ "$DISTRO" = "rhel" ] || [ "$DISTRO" = "centos" ]; then
            sudo dnf install -y gh || sudo yum install -y gh
        elif [ "$DISTRO" = "arch" ]; then
            sudo pacman -S --noconfirm github-cli
        else
            echo -e "${YELLOW}⚠️  Please install GitHub CLI manually for your distribution${NC}"
            echo "Visit: https://cli.github.com/manual/installation"
        fi
    fi

    echo -e "${GREEN}✅ GitHub CLI installed successfully!${NC}"
    echo ""
else
    GH_VERSION=$(gh --version | head -n1 | cut -d' ' -f3)
    echo -e "${GREEN}✅ GitHub CLI already installed (v$GH_VERSION)${NC}"
    echo ""
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5. AUTHENTICATE GITHUB CLI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if command -v gh &> /dev/null; then
    # Check if already authenticated
    if ! gh auth status &> /dev/null; then
        echo -e "${CYAN}🔑 GitHub CLI authentication required${NC}"
        echo ""
        echo "Genie needs GitHub access to create issues, PRs, and manage repos."
        echo "This will open your browser for secure OAuth authentication."
        echo ""
        echo -e "${YELLOW}Press Enter to authenticate, or Ctrl+C to skip (you can do this later)${NC}"
        read -r

        # Start interactive auth
        gh auth login --web -h github.com || {
            echo -e "${YELLOW}⚠️  GitHub authentication skipped or failed${NC}"
            echo "You can authenticate later with: gh auth login"
            echo ""
        }
    else
        GH_USER=$(gh api user --jq '.login' 2>/dev/null || echo "unknown")
        echo -e "${GREEN}✅ GitHub CLI authenticated as @$GH_USER${NC}"
        echo ""
    fi
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 6. INSTALL NODE.JS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if ! command -v node &> /dev/null; then
    echo -e "${MAGENTA}📦 Installing Node.js (runtime for Genie)...${NC}"

    if [ "$OS_TYPE" = "macos" ]; then
        # Use Homebrew for macOS
        brew install node@22 || brew install node
    else
        # Use nvm for Linux/Unix (user-local, no sudo needed)
        if [ ! -d "$HOME/.nvm" ]; then
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
        fi

        export NVM_DIR="$HOME/.nvm"
        [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

        nvm install 22
        nvm use 22
        nvm alias default 22
    fi

    echo -e "${GREEN}✅ Node.js installed successfully!${NC}"
    echo ""
else
    NODE_VERSION=$(node --version)
    echo -e "${GREEN}✅ Node.js already installed ($NODE_VERSION)${NC}"
    echo ""
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 7. INSTALL PNPM
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if ! command -v pnpm &> /dev/null; then
    echo -e "${MAGENTA}⚡ Installing pnpm (fast package manager)...${NC}"

    if [ "$OS_TYPE" = "macos" ]; then
        # Use Homebrew for macOS
        brew install pnpm
    else
        # Set up user-local directory for package managers
        export PNPM_HOME="$HOME/.local/share/pnpm"
        mkdir -p "$PNPM_HOME"

        # Install via npm with user prefix (no sudo needed)
        npm install -g pnpm --prefix="$HOME/.local"

        # Add to PATH
        export PATH="$HOME/.local/bin:$PNPM_HOME:$PATH"

        # Add to shell profile for persistence
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
    fi

    # Verify pnpm is available
    if ! command -v pnpm &> /dev/null; then
        echo -e "${YELLOW}⚠️  pnpm installed but not in PATH. Run this spell:${NC}"
        echo "    export PATH=\"$HOME/.local/bin:\$PNPM_HOME:\$PATH\""
        exit 1
    fi

    echo -e "${GREEN}✅ pnpm installed successfully!${NC}"
    echo ""
else
    PNPM_VERSION=$(pnpm --version)
    echo -e "${GREEN}✅ pnpm already installed (v$PNPM_VERSION)${NC}"
    echo ""
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 8. INSTALL/UPDATE GENIE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if command -v genie &> /dev/null; then
    # Get installed version
    INSTALLED_VERSION=$(genie --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?' || echo "0.0.0")

    # Get latest @next version from npm (silent, fast)
    LATEST_VERSION=$(npm view automagik-genie@next version 2>/dev/null || echo "$INSTALLED_VERSION")

    # Compare versions
    if [ "$INSTALLED_VERSION" != "$LATEST_VERSION" ]; then
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🧞 ✨ MASTER GENIE HAS EVOLVED ✨"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "Your clone:   $INSTALLED_VERSION"
        echo "Master Genie: $LATEST_VERSION ⭐ NEW!"
        echo ""
        echo -e "${CYAN}⚡ Syncing new capabilities from the Master Genie...${NC}"
        pnpm install -g automagik-genie@next
        echo ""
        echo -e "${GREEN}✅ You're now running v$LATEST_VERSION! ✨${NC}"
        echo "✓ All data stays local on your machine"
        echo ""
    fi
else
    # Not installed - install it globally first
    echo -e "${CYAN}🎩 Pulling Genie from the lamp...${NC}"
    pnpm install -g automagik-genie@next
    echo ""
    echo -e "${GREEN}✅ Genie is ready to grant your wishes! ✨${NC}"
    echo ""
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 9. FINAL SUMMARY & LAUNCH
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✨ INSTALLATION COMPLETE ✨${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📦 Installed dependencies:"
if command -v git &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} git ($(git --version | cut -d' ' -f3))"
fi
if command -v gh &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} GitHub CLI ($(gh --version | head -n1 | cut -d' ' -f3))"
fi
if command -v node &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Node.js ($(node --version))"
fi
if command -v pnpm &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} pnpm (v$(pnpm --version))"
fi
if command -v genie &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Genie ($(genie --version 2>/dev/null || echo 'installed'))"
fi
echo ""
echo "🧞 Your wish is my command..."
echo ""

# Launch Genie - use exec to replace this shell process
if [ $# -eq 0 ]; then
    exec genie
else
    # Arguments provided - pass through
    exec genie "$@"
fi
