#!/usr/bin/env bash
# 🧞 Genie - Your wish is my command ✨
set -e

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# COLOR CODES
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# HELPER FUNCTIONS - Package Installation
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# macOS package installation via Homebrew
install_macos() {
    local package="$1"
    brew install "$package"
}

# Ubuntu/Debian package installation via apt-get
install_ubuntu() {
    local package="$1"
    sudo apt-get update && sudo apt-get install -y "$package"
}

# Fedora/RHEL/CentOS package installation via dnf/yum
install_fedora() {
    local package="$1"
    sudo dnf install -y "$package" 2>/dev/null || sudo yum install -y "$package"
}

# Arch Linux package installation via pacman
install_arch() {
    local package="$1"
    sudo pacman -S --noconfirm "$package"
}

# Generic cross-platform package installer
# Usage: install_package <package_name> [macos_name] [ubuntu_name] [fedora_name] [arch_name]
install_package() {
    local default_name="$1"
    local macos_name="${2:-$default_name}"
    local ubuntu_name="${3:-$default_name}"
    local fedora_name="${4:-$default_name}"
    local arch_name="${5:-$default_name}"

    case "$OS_TYPE" in
        macos)
            install_macos "$macos_name"
            ;;
        linux)
            case "$DISTRO" in
                ubuntu|debian)
                    install_ubuntu "$ubuntu_name"
                    ;;
                fedora|rhel|centos)
                    install_fedora "$fedora_name"
                    ;;
                arch)
                    install_arch "$arch_name"
                    ;;
                *)
                    echo -e "${YELLOW}⚠️  Unsupported Linux distribution: $DISTRO${NC}"
                    echo "Please install $default_name manually"
                    return 1
                    ;;
            esac
            ;;
        *)
            echo -e "${YELLOW}⚠️  Unsupported operating system: $OS_TYPE${NC}"
            return 1
            ;;
    esac
}

# Check if a command exists
command_exists() {
    command -v "$1" &> /dev/null
}

# Add line to shell profile if not already present
add_to_profile() {
    local line="$1"
    local comment="$2"

    for profile in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.profile"; do
        if [ -f "$profile" ] && [ -w "$profile" ]; then
            if ! grep -qF "$line" "$profile" 2>/dev/null; then
                {
                    echo ''
                    echo "# $comment"
                    echo "$line"
                } >> "$profile" 2>/dev/null || true
            fi
        fi
    done
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# WELCOME MESSAGE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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
DISTRO="unknown"
ARCH=$(uname -m)

if [[ "$OSTYPE" == "darwin"* ]]; then
    OS_TYPE="macos"
    echo -e "${CYAN}🍎 Detected: macOS (${ARCH})${NC}"

elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ "$OSTYPE" == "linux"* ]]; then
    OS_TYPE="linux"

    # Detect Linux distribution
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        DISTRO=$ID
        echo -e "${CYAN}🐧 Detected: Linux - $DISTRO (${ARCH})${NC}"
    else
        echo -e "${CYAN}🐧 Detected: Linux - unknown distro (${ARCH})${NC}"
    fi

elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
    OS_TYPE="windows"
    echo -e "${CYAN}🪟 Detected: Windows - Git Bash/WSL (${ARCH})${NC}"

else
    echo -e "${YELLOW}⚠️  Unknown OS: $OSTYPE${NC}"
    echo "Attempting to continue with generic Unix installation..."
    OS_TYPE="unix"
fi

echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. INSTALL HOMEBREW (macOS only)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

install_homebrew() {
    if [ "$OS_TYPE" != "macos" ]; then
        return 0  # Skip if not macOS
    fi

    if command_exists brew; then
        echo -e "${GREEN}✅ Homebrew already installed${NC}"
        echo ""
        return 0
    fi

    echo -e "${MAGENTA}🍺 Installing Homebrew (package manager for macOS)...${NC}"
    echo "This is essential for installing dependencies easily."
    echo ""

    # Install Homebrew (official installation script)
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

    # Determine Homebrew path based on architecture
    if [[ "$ARCH" == "arm64" ]]; then
        BREW_PATH="/opt/homebrew"  # Apple Silicon
    else
        BREW_PATH="/usr/local"     # Intel
    fi

    # Add to current session
    export PATH="$BREW_PATH/bin:$PATH"

    # Add to shell profiles for persistence
    add_to_profile "export PATH=\"$BREW_PATH/bin:\$PATH\"" "Homebrew (added by Genie installer)"

    echo -e "${GREEN}✅ Homebrew installed successfully!${NC}"
    echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. INSTALL GIT
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

install_git() {
    if command_exists git; then
        local git_version=$(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        echo -e "${GREEN}✅ Git already installed (v${git_version})${NC}"
        echo ""
        return 0
    fi

    echo -e "${MAGENTA}📦 Installing git (version control)...${NC}"

    if ! install_package git; then
        echo -e "${RED}❌ Failed to install git${NC}"
        echo "Visit: https://git-scm.com/downloads"
        exit 1
    fi

    echo -e "${GREEN}✅ Git installed successfully!${NC}"
    echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. INSTALL GITHUB CLI (gh)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

install_github_cli() {
    if command_exists gh; then
        local gh_version=$(gh --version | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
        echo -e "${GREEN}✅ GitHub CLI already installed (v${gh_version})${NC}"
        echo ""
        return 0
    fi

    echo -e "${MAGENTA}📦 Installing GitHub CLI (gh)...${NC}"

    case "$OS_TYPE" in
        macos)
            install_macos gh
            ;;
        linux)
            case "$DISTRO" in
                ubuntu|debian)
                    # Official GitHub CLI installation for Debian/Ubuntu
                    type -p curl >/dev/null || install_ubuntu curl
                    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | \
                        sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
                    sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
                    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | \
                        sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
                    sudo apt-get update
                    install_ubuntu gh
                    ;;
                fedora|rhel|centos)
                    install_fedora gh
                    ;;
                arch)
                    install_arch github-cli
                    ;;
                *)
                    echo -e "${YELLOW}⚠️  Please install GitHub CLI manually for $DISTRO${NC}"
                    echo "Visit: https://cli.github.com/manual/installation"
                    return 1
                    ;;
            esac
            ;;
    esac

    echo -e "${GREEN}✅ GitHub CLI installed successfully!${NC}"
    echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5. AUTHENTICATE GITHUB CLI
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

authenticate_github() {
    if ! command_exists gh; then
        return 0  # Skip if gh not installed
    fi

    # Check if already authenticated
    if gh auth status &> /dev/null; then
        local gh_user=$(gh api user --jq '.login' 2>/dev/null || echo "unknown")
        echo -e "${GREEN}✅ GitHub CLI authenticated as @${gh_user}${NC}"
        echo ""
        return 0
    fi

    echo -e "${CYAN}🔑 GitHub CLI authentication required${NC}"
    echo ""
    echo "Genie needs GitHub access to create issues, PRs, and manage repos."
    echo "This will open your browser for secure OAuth authentication."
    echo ""
    echo -e "${YELLOW}Press Enter to authenticate, or Ctrl+C to skip (you can do this later)${NC}"
    read -r

    # Start interactive auth
    if gh auth login --web -h github.com; then
        local gh_user=$(gh api user --jq '.login' 2>/dev/null || echo "you")
        echo -e "${GREEN}✅ Authenticated as @${gh_user}${NC}"
    else
        echo -e "${YELLOW}⚠️  GitHub authentication skipped or failed${NC}"
        echo "You can authenticate later with: gh auth login"
    fi
    echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 6. INSTALL NODE.JS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

install_nodejs() {
    if command_exists node; then
        local node_version=$(node --version)
        echo -e "${GREEN}✅ Node.js already installed (${node_version})${NC}"
        echo ""
        return 0
    fi

    echo -e "${MAGENTA}📦 Installing Node.js (runtime for Genie)...${NC}"

    case "$OS_TYPE" in
        macos)
            # Use Homebrew for macOS - try node@22 first, fallback to latest
            install_macos node@22 2>/dev/null || install_macos node
            ;;
        *)
            # Use nvm for Linux/Unix (user-local, no sudo needed)
            if [ ! -d "$HOME/.nvm" ]; then
                curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
            fi

            export NVM_DIR="$HOME/.nvm"
            [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

            nvm install 22
            nvm use 22
            nvm alias default 22
            ;;
    esac

    echo -e "${GREEN}✅ Node.js installed successfully!${NC}"
    echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 7. INSTALL PNPM
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

install_pnpm() {
    if command_exists pnpm; then
        local pnpm_version=$(pnpm --version)
        echo -e "${GREEN}✅ pnpm already installed (v${pnpm_version})${NC}"
        echo ""
        return 0
    fi

    echo -e "${MAGENTA}⚡ Installing pnpm (fast package manager)...${NC}"

    case "$OS_TYPE" in
        macos)
            # Use Homebrew for macOS
            install_macos pnpm
            ;;
        *)
            # Set up user-local directory for package managers
            export PNPM_HOME="$HOME/.local/share/pnpm"
            mkdir -p "$PNPM_HOME"

            # Install via npm with user prefix (no sudo needed)
            npm install -g pnpm --prefix="$HOME/.local"

            # Add to PATH for current session
            export PATH="$HOME/.local/bin:$PNPM_HOME:$PATH"

            # Add to shell profiles for persistence
            add_to_profile "export PNPM_HOME=\"\$HOME/.local/share/pnpm\"" "pnpm configuration (added by Genie installer)"
            add_to_profile "export PATH=\"\$HOME/.local/bin:\$PNPM_HOME:\$PATH\"" "pnpm PATH (added by Genie installer)"
            ;;
    esac

    # Verify pnpm is available
    if ! command_exists pnpm; then
        echo -e "${YELLOW}⚠️  pnpm installed but not in PATH. Run this spell:${NC}"
        echo "    export PATH=\"\$HOME/.local/bin:\$PNPM_HOME:\$PATH\""
        exit 1
    fi

    echo -e "${GREEN}✅ pnpm installed successfully!${NC}"
    echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 8. INSTALL/UPDATE GENIE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

install_genie() {
    if command_exists genie; then
        # Get installed version
        local installed_version=$(genie --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?' || echo "0.0.0")

        # Get latest @latest version from npm (silent, fast)
        local latest_version=$(npm view automagik-genie@latest version 2>/dev/null || echo "$installed_version")

        # Compare versions
        if [ "$installed_version" != "$latest_version" ]; then
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "🧞 ✨ MASTER GENIE HAS EVOLVED ✨"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Your clone:   $installed_version"
            echo "Master Genie: $latest_version ⭐ NEW!"
            echo ""
            echo -e "${CYAN}⚡ Syncing new capabilities from the Master Genie...${NC}"
            pnpm install -g automagik-genie@latest
            echo ""
            echo -e "${GREEN}✅ You're now running v${latest_version}! ✨${NC}"
            echo "✓ All data stays local on your machine"
            echo ""
        else
            echo -e "${GREEN}✅ Genie already up-to-date (v${installed_version})${NC}"
            echo ""
        fi
    else
        # Not installed - install it globally
        echo -e "${CYAN}🎩 Pulling Genie from the lamp...${NC}"
        pnpm install -g automagik-genie@latest
        echo ""
        echo -e "${GREEN}✅ Genie is ready to grant your wishes! ✨${NC}"
        echo ""
    fi
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 9. INSTALLATION SUMMARY
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

show_summary() {
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo -e "${GREEN}✨ INSTALLATION COMPLETE ✨${NC}"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "📦 Installed dependencies:"

    if command_exists git; then
        local git_ver=$(git --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
        echo -e "  ${GREEN}✓${NC} git (v${git_ver})"
    fi

    if command_exists gh; then
        local gh_ver=$(gh --version | head -n1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
        echo -e "  ${GREEN}✓${NC} GitHub CLI (v${gh_ver})"
    fi

    if command_exists node; then
        local node_ver=$(node --version)
        echo -e "  ${GREEN}✓${NC} Node.js (${node_ver})"
    fi

    if command_exists pnpm; then
        local pnpm_ver=$(pnpm --version)
        echo -e "  ${GREEN}✓${NC} pnpm (v${pnpm_ver})"
    fi

    if command_exists genie; then
        local genie_ver=$(genie --version 2>/dev/null || echo "installed")
        echo -e "  ${GREEN}✓${NC} Genie (${genie_ver})"
    fi

    echo ""
    echo "🧞 Your wish is my command..."
    echo ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# MAIN INSTALLATION FLOW
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Execute installation steps in order
install_homebrew
install_git
install_github_cli
authenticate_github
install_nodejs
install_pnpm
install_genie

# Show final summary
show_summary

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${CYAN}🧞 Launching Genie...${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "The Genie wizard will guide you through:"
echo "  • Template selection (code/create)"
echo "  • AI executor selection"
echo "  • Executor authentication"
echo "  • Workspace initialization"
echo ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LAUNCH GENIE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Replace this shell process with genie (no extra process left behind)
if [ $# -eq 0 ]; then
    exec genie
else
    exec genie "$@"
fi
