#!/usr/bin/env bash
#
# Genie CLI Installer
# https://github.com/namastexlabs/genie-cli
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash -s -- uninstall
#
# Exit codes:
#   0 - Success
#   1 - General error
#   2 - Invalid arguments
#   3 - Missing prerequisites
#   4 - Download failed
#   5 - Build failed

set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# Constants
# ─────────────────────────────────────────────────────────────────────────────

readonly VERSION="2.0.0"
readonly PACKAGE_NAME="@automagik/genie"
readonly RAW_REPO_URL="https://raw.githubusercontent.com/namastexlabs/genie-cli"

readonly GENIE_HOME="${GENIE_HOME:-$HOME/.genie}"

# Colors (disabled if not a terminal)
if [[ -t 1 ]]; then
    readonly RED='\033[0;31m'
    readonly GREEN='\033[0;32m'
    readonly YELLOW='\033[1;33m'
    readonly BLUE='\033[0;34m'
    readonly BOLD='\033[1m'
    readonly DIM='\033[2m'
    readonly NC='\033[0m'
else
    readonly RED=''
    readonly GREEN=''
    readonly YELLOW=''
    readonly BLUE=''
    readonly BOLD=''
    readonly DIM=''
    readonly NC=''
fi

# Global state
DOWNLOADER=""
PLATFORM=""
ARCH=""
INSTALL_MODE="install"

# ─────────────────────────────────────────────────────────────────────────────
# Utility Functions
# ─────────────────────────────────────────────────────────────────────────────

log() {
    echo -e "  ${GREEN}▸${NC} $1"
}

warn() {
    echo -e "  ${YELLOW}⚠${NC} $1" >&2
}

error() {
    echo -e "  ${RED}✖${NC} $1" >&2
}

success() {
    echo -e "  ${GREEN}✔${NC} $1"
}

info() {
    echo -e "  ${BLUE}ℹ${NC} $1"
}

header() {
    echo
    echo -e "${BOLD}$1${NC}"
}

# Check if a command exists
check_command() {
    command -v "$1" &>/dev/null
}

# Prompt user for confirmation (Y is default)
confirm() {
    local prompt="$1"
    echo -en "${YELLOW}?${NC} $prompt [Y/n] "
    read -r response < /dev/tty || response=""
    [[ -z "$response" || "$response" =~ ^[Yy]$ ]]
}

# Prompt user for confirmation (N is default)
confirm_no() {
    local prompt="$1"
    echo -en "${YELLOW}?${NC} $prompt [y/N] "
    read -r response < /dev/tty || response=""
    [[ "$response" =~ ^[Yy]$ ]]
}

# ─────────────────────────────────────────────────────────────────────────────
# Platform Detection
# ─────────────────────────────────────────────────────────────────────────────

detect_platform() {
    local os arch

    case "$(uname -s)" in
        Darwin)
            os="darwin"
            ;;
        Linux)
            os="linux"
            ;;
        MINGW*|MSYS*|CYGWIN*)
            os="windows"
            ;;
        *)
            error "Unsupported operating system: $(uname -s)"
            exit 3
            ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64)
            arch="x64"
            ;;
        aarch64|arm64)
            arch="arm64"
            ;;
        armv7l)
            arch="arm"
            ;;
        *)
            error "Unsupported architecture: $(uname -m)"
            exit 3
            ;;
    esac

    PLATFORM="$os"
    ARCH="$arch"

    log "Detected platform: ${BOLD}$PLATFORM-$ARCH${NC}"
}

# ─────────────────────────────────────────────────────────────────────────────
# Download Utilities
# ─────────────────────────────────────────────────────────────────────────────

init_downloader() {
    if check_command curl; then
        DOWNLOADER="curl"
    elif check_command wget; then
        DOWNLOADER="wget"
    else
        error "Neither curl nor wget found. Please install one of them."
        exit 3
    fi
}

# Download a file to stdout
download() {
    local url="$1"
    case "$DOWNLOADER" in
        curl)
            curl -fsSL "$url"
            ;;
        wget)
            wget -qO- "$url"
            ;;
    esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Package Manager Detection
# ─────────────────────────────────────────────────────────────────────────────

detect_package_manager() {
    if check_command brew; then
        echo "brew"
    elif check_command apt-get; then
        echo "apt"
    elif check_command dnf; then
        echo "dnf"
    elif check_command yum; then
        echo "yum"
    elif check_command pacman; then
        echo "pacman"
    elif check_command apk; then
        echo "apk"
    elif check_command zypper; then
        echo "zypper"
    else
        echo "unknown"
    fi
}

# Install a package using the detected package manager
install_package() {
    local package="$1"
    local pm
    pm=$(detect_package_manager)

    case "$pm" in
        brew)
            brew install "$package"
            ;;
        apt)
            sudo apt-get update -qq && sudo apt-get install -y "$package"
            ;;
        dnf)
            sudo dnf install -y "$package"
            ;;
        yum)
            sudo yum install -y "$package"
            ;;
        pacman)
            sudo pacman -S --noconfirm "$package"
            ;;
        apk)
            sudo apk add --no-cache "$package"
            ;;
        zypper)
            sudo zypper install -y "$package"
            ;;
        *)
            return 1
            ;;
    esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Prerequisite Installation
# ─────────────────────────────────────────────────────────────────────────────

install_git_if_needed() {
    if check_command git; then
        success "git found"
        return 0
    fi

    log "Installing git..."
    if install_package "git" && check_command git; then
        success "git installed"
    else
        error "git is required but could not be installed"
        exit 3
    fi
}

install_node_if_needed() {
    if check_command node; then
        local node_version
        node_version=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
        if [[ "$node_version" -ge 20 ]]; then
            success "Node.js v$(node --version | sed 's/v//') found"
            return 0
        fi
    fi

    log "Installing Node.js..."

    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

    if [[ ! -d "$NVM_DIR" ]]; then
        download "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" | bash
    fi

    # shellcheck source=/dev/null
    [[ -s "$NVM_DIR/nvm.sh" ]] && \. "$NVM_DIR/nvm.sh"

    nvm install 22
    nvm use 22
    nvm alias default 22

    success "Node.js $(node --version) installed"
}

install_bun_if_needed() {
    if check_command bun; then
        success "Bun $(bun --version) found"
        return 0
    fi

    log "Installing Bun..."
    download "https://bun.sh/install" | bash

    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    export PATH="$BUN_INSTALL/bin:$PATH"

    if check_command bun; then
        success "Bun $(bun --version) installed"
    else
        error "Bun installation failed"
        exit 5
    fi
}

install_tmux_if_needed() {
    if check_command tmux; then
        success "tmux installed"
        return 0
    fi

    log "Installing tmux..."
    if install_package "tmux" && check_command tmux; then
        success "tmux installed"
    else
        warn "Could not install tmux automatically"
    fi
}

install_jq_if_needed() {
    if check_command jq; then
        success "jq installed"
        return 0
    fi

    log "Installing jq..."
    if install_package "jq" && check_command jq; then
        success "jq installed"
    else
        warn "Could not install jq automatically"
    fi
}

install_rg_if_needed() {
    if check_command rg; then
        success "ripgrep installed"
        return 0
    fi

    log "Installing ripgrep..."
    if install_package "ripgrep" && check_command rg; then
        success "ripgrep installed"
    else
        warn "Could not install ripgrep automatically"
    fi
}

install_claude_if_needed() {
    if check_command claude; then
        success "Claude Code CLI installed"
        return 0
    fi

    log "Installing Claude Code CLI..."

    if check_command bun; then
        bun install -g @anthropic-ai/claude-code
    elif check_command npm; then
        npm install -g @anthropic-ai/claude-code
    else
        warn "Neither bun nor npm found"
        return 1
    fi

    if check_command claude; then
        success "Claude Code CLI installed"
    else
        warn "Claude Code installed but not in PATH yet"
        warn "You may need to restart your shell"
    fi
}

install_plugin_if_needed() {
    if claude plugin list 2>/dev/null | grep -q "automagik-genie"; then
        success "automagik-genie plugin already installed"
        return 0
    fi

    log "Installing automagik-genie plugin..."
    if claude plugin install namastexlabs/automagik-genie; then
        success "automagik-genie plugin installed"
    else
        warn "Plugin installation failed"
        info "Try manually: claude plugin install namastexlabs/automagik-genie"
        return 1
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Genie CLI Installation
# ─────────────────────────────────────────────────────────────────────────────

install_genie_cli() {
    log "Installing $PACKAGE_NAME..."

    if check_command bun; then
        bun install -g "$PACKAGE_NAME"
    elif check_command npm; then
        npm install -g "$PACKAGE_NAME"
    else
        error "Neither bun nor npm found"
        exit 3
    fi

    success "$PACKAGE_NAME installed"
}

# ─────────────────────────────────────────────────────────────────────────────
# Claudio Setup
# ─────────────────────────────────────────────────────────────────────────────

run_claudio_setup() {
    log "Running claudio setup..."
    if check_command claudio; then
        claudio setup
    else
        warn "claudio command not found"
        info "Run 'claudio setup' after restarting your shell"
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Main Install Flow
# ─────────────────────────────────────────────────────────────────────────────

run_install() {
    # Required prerequisites
    header "Installing prerequisites..."
    install_git_if_needed
    install_node_if_needed
    install_bun_if_needed
    install_tmux_if_needed
    install_jq_if_needed
    install_rg_if_needed

    # Genie CLI (required)
    header "Installing Genie CLI..."
    install_genie_cli

    # Optional: Claude Code CLI
    echo
    info "AI-powered coding assistant from Anthropic"
    if confirm "Install Claude Code CLI?"; then
        install_claude_if_needed

        # Optional: Genie Plugin (only if Claude installed)
        if check_command claude; then
            echo
            info "Adds skills, agents, and hooks to Claude Code"
            if confirm "Install Genie plugin for Claude Code?"; then
                install_plugin_if_needed
            fi
        fi
    fi

    # Optional: Claudio setup
    echo
    info "Manage multiple Claude API configurations"
    if confirm "Configure Claudio profiles?"; then
        run_claudio_setup
    fi

    print_success
}

# ─────────────────────────────────────────────────────────────────────────────
# Main Uninstall Flow
# ─────────────────────────────────────────────────────────────────────────────

run_uninstall() {
    echo
    echo -e "${BOLD}Genie CLI Uninstaller${NC}"
    echo -e "${DIM}────────────────────────────────────${NC}"
    echo

    if ! confirm_no "Remove Genie CLI and all components?"; then
        info "Cancelled"
        exit 0
    fi

    echo
    log "Removing..."

    # Remove plugin
    if check_command claude; then
        if claude plugin uninstall namastexlabs/automagik-genie 2>/dev/null; then
            success "Claude Code plugin removed"
        fi
    fi

    # Remove genie-cli
    if check_command bun; then
        bun remove -g "$PACKAGE_NAME" 2>/dev/null || true
    fi
    if check_command npm; then
        npm uninstall -g "$PACKAGE_NAME" 2>/dev/null || true
    fi
    success "Genie CLI removed"

    # Clean config
    if [[ -d "$GENIE_HOME" ]]; then
        rm -rf "$GENIE_HOME"
        success "Configuration cleaned"
    fi

    echo
    success "Done"
}

# ─────────────────────────────────────────────────────────────────────────────
# Success Message
# ─────────────────────────────────────────────────────────────────────────────

print_success() {
    echo
    echo -e "${DIM}────────────────────────────────────${NC}"
    echo -e "${GREEN}${BOLD}Genie CLI installed successfully!${NC}"
    echo -e "${DIM}────────────────────────────────────${NC}"
    echo
}

# ─────────────────────────────────────────────────────────────────────────────
# Argument Parsing
# ─────────────────────────────────────────────────────────────────────────────

print_usage() {
    cat <<EOF
Genie CLI Installer

Usage:
  curl -fsSL $RAW_REPO_URL/main/install.sh | bash
  curl -fsSL $RAW_REPO_URL/main/install.sh | bash -s -- uninstall

Commands:
  (default)   Interactive install
  uninstall   Remove Genie CLI and components
  --help      Show this help message
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            uninstall)
                INSTALL_MODE="uninstall"
                ;;
            --help|-h)
                print_usage
                exit 0
                ;;
            *)
                error "Unknown argument: $1"
                echo
                print_usage
                exit 2
                ;;
        esac
        shift
    done
}

# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────

main() {
    parse_args "$@"

    echo
    echo -e "${BOLD}Genie CLI Installer${NC}"
    echo -e "${DIM}────────────────────────────────────${NC}"
    echo

    init_downloader
    detect_platform

    case "$INSTALL_MODE" in
        install)
            run_install
            ;;
        uninstall)
            run_uninstall
            ;;
    esac
}

main "$@"
