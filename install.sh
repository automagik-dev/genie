#!/usr/bin/env bash
#
# Genie CLI Installer
# https://github.com/namastexlabs/genie-cli
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/namastexlabs/genie-cli/main/install.sh | bash
#   curl ... | bash -s -- quick|full|source|update [--version=X] [--yes]
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

readonly VERSION="1.0.0"
readonly PACKAGE_NAME="@automagik/genie"
readonly REPO_URL="https://github.com/namastexlabs/genie-cli.git"
readonly RAW_REPO_URL="https://raw.githubusercontent.com/namastexlabs/genie-cli"
readonly NPM_REGISTRY="https://registry.npmjs.org"

readonly GENIE_HOME="${GENIE_HOME:-$HOME/.genie}"
readonly GENIE_SRC="$GENIE_HOME/src"
readonly GENIE_BIN="$GENIE_HOME/bin"
readonly LOCAL_BIN="$HOME/.local/bin"

# Colors (disabled if not a terminal)
if [[ -t 1 ]]; then
    readonly RED='\033[0;31m'
    readonly GREEN='\033[0;32m'
    readonly YELLOW='\033[1;33m'
    readonly CYAN='\033[0;36m'
    readonly BLUE='\033[0;34m'
    readonly BOLD='\033[1m'
    readonly DIM='\033[2m'
    readonly NC='\033[0m'
else
    readonly RED=''
    readonly GREEN=''
    readonly YELLOW=''
    readonly CYAN=''
    readonly BLUE=''
    readonly BOLD=''
    readonly DIM=''
    readonly NC=''
fi

# Global state
DOWNLOADER=""
PLATFORM=""
ARCH=""
LIBC=""
INSTALL_MODE="auto"
INSTALL_METHOD=""
TARGET_VERSION="stable"
AUTO_YES=false
CLEANUP_NEEDED=false
TEMP_DIR=""

# ─────────────────────────────────────────────────────────────────────────────
# Utility Functions
# ─────────────────────────────────────────────────────────────────────────────

log() {
    echo -e "${GREEN}▸${NC} $1"
}

warn() {
    echo -e "${YELLOW}⚠${NC} $1" >&2
}

error() {
    echo -e "${RED}✖${NC} $1" >&2
}

success() {
    echo -e "${GREEN}✔${NC} $1"
}

info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

header() {
    echo
    echo -e "${BOLD}$1${NC}"
    echo
}

# Run a command with visible output
run() {
    echo -e "${DIM}$ $*${NC}"
    "$@"
}

# Check if a command exists
check_command() {
    command -v "$1" &>/dev/null
}

# Prompt user for confirmation
confirm() {
    local prompt="$1"
    if [[ "$AUTO_YES" == true ]]; then
        return 0
    fi
    echo -en "${YELLOW}?${NC} $prompt [y/N] "
    read -r response
    [[ "$response" =~ ^[Yy]$ ]]
}

# ─────────────────────────────────────────────────────────────────────────────
# Cleanup
# ─────────────────────────────────────────────────────────────────────────────

cleanup() {
    local exit_code=$?
    if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
        rm -rf "$TEMP_DIR"
    fi
    if [[ "$CLEANUP_NEEDED" == true && $exit_code -ne 0 ]]; then
        warn "Installation failed. Cleaning up..."
        # Don't remove existing installations on update failure
        if [[ "$INSTALL_MODE" != "update" && -d "$GENIE_SRC" ]]; then
            rm -rf "$GENIE_SRC"
        fi
    fi
    exit $exit_code
}

trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Platform Detection
# ─────────────────────────────────────────────────────────────────────────────

detect_platform() {
    local os arch libc

    # Detect OS
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

    # Detect architecture
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

    # Detect libc (Linux only)
    libc=""
    if [[ "$os" == "linux" ]]; then
        # Check for musl (Alpine, etc.)
        if ldd --version 2>&1 | grep -qi musl; then
            libc="musl"
        elif [[ -f /etc/alpine-release ]]; then
            libc="musl"
        fi
    fi

    PLATFORM="$os"
    ARCH="$arch"
    LIBC="$libc"

    local platform_str="$PLATFORM-$ARCH"
    if [[ -n "$LIBC" ]]; then
        platform_str="$platform_str-$LIBC"
    fi

    log "Detected platform: $platform_str"
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

# Download a file to a path
download_file() {
    local url="$1"
    local dest="$2"
    case "$DOWNLOADER" in
        curl)
            curl -fsSL -o "$dest" "$url"
            ;;
        wget)
            wget -q -O "$dest" "$url"
            ;;
    esac
}

# Parse a JSON field (jq with bash fallback)
parse_json_field() {
    local json="$1"
    local field="$2"

    if check_command jq; then
        echo "$json" | jq -r ".$field // empty"
    else
        # Bash regex fallback for simple cases
        local pattern="\"$field\"[[:space:]]*:[[:space:]]*\"([^\"]*)\""
        if [[ $json =~ $pattern ]]; then
            echo "${BASH_REMATCH[1]}"
        fi
    fi
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

    log "Installing $package..."

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
            warn "Unknown package manager. Please install $package manually."
            return 1
            ;;
    esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Prerequisite Installation
# ─────────────────────────────────────────────────────────────────────────────

install_node_if_needed() {
    # Check if Node 20+ is already available
    if check_command node; then
        local node_version
        node_version=$(node --version 2>/dev/null | sed 's/v//' | cut -d. -f1)
        if [[ "$node_version" -ge 20 ]]; then
            success "Node.js v$(node --version | sed 's/v//') found"
            return 0
        fi
    fi

    log "Node.js 20+ not found, installing..."

    # Check if nvm is installed
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

    if [[ ! -d "$NVM_DIR" ]]; then
        log "Installing nvm..."
        download "https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh" | bash
    fi

    # Source nvm
    # shellcheck source=/dev/null
    [[ -s "$NVM_DIR/nvm.sh" ]] && \. "$NVM_DIR/nvm.sh"

    # Install Node 22
    log "Installing Node.js 22 via nvm..."
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

    # Add bun to PATH for this session
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
        success "tmux $(tmux -V 2>/dev/null | cut -d' ' -f2) found"
        return 0
    fi

    local pm
    pm=$(detect_package_manager)

    # Map package name per package manager
    local pkg="tmux"

    if install_package "$pkg"; then
        if check_command tmux; then
            success "tmux installed"
            return 0
        fi
    fi

    warn "Could not install tmux. Please install it manually."
    warn "Visit: https://github.com/tmux/tmux/wiki/Installing"
    return 1
}

install_jq_if_needed() {
    if check_command jq; then
        success "jq found"
        return 0
    fi

    if install_package "jq"; then
        if check_command jq; then
            success "jq installed"
            return 0
        fi
    fi

    warn "Could not install jq. JSON parsing will use fallback method."
    return 1
}

install_rg_if_needed() {
    if check_command rg; then
        success "ripgrep found"
        return 0
    fi

    local pm
    pm=$(detect_package_manager)

    # Package name varies
    local pkg="ripgrep"

    if install_package "$pkg"; then
        if check_command rg; then
            success "ripgrep installed"
            return 0
        fi
    fi

    warn "Could not install ripgrep. Some features may be limited."
    return 1
}

install_git_if_needed() {
    if check_command git; then
        success "git found"
        return 0
    fi

    if install_package "git"; then
        if check_command git; then
            success "git installed"
            return 0
        fi
    fi

    error "git is required but could not be installed"
    exit 3
}

install_claude_if_needed() {
    if check_command claude; then
        success "Claude Code CLI found"
        return 0
    fi

    log "Installing Claude Code CLI..."

    # Prefer bun for installation
    if check_command bun; then
        bun install -g @anthropic-ai/claude-code
    elif check_command npm; then
        npm install -g @anthropic-ai/claude-code
    else
        warn "Neither bun nor npm found. Please install Claude Code manually."
        return 1
    fi

    if check_command claude; then
        success "Claude Code CLI installed"
    else
        warn "Claude Code installed but not in PATH yet"
        warn "You may need to restart your shell"
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Config Management
# ─────────────────────────────────────────────────────────────────────────────

# Write install method to ~/.genie/config.json
write_install_method() {
    local method="$1"
    local config_file="$GENIE_HOME/config.json"

    mkdir -p "$GENIE_HOME"

    if [[ -f "$config_file" ]]; then
        # Update existing config
        if check_command jq; then
            jq --arg m "$method" '.installMethod = $m' "$config_file" > "$config_file.tmp" && mv "$config_file.tmp" "$config_file"
        else
            # Fallback: read file, check if it has content
            local content
            content=$(cat "$config_file" 2>/dev/null || echo "{}")
            if [[ "$content" == "{}" || -z "$content" ]]; then
                echo "{\"installMethod\":\"$method\"}" > "$config_file"
            else
                # Simple sed to add installMethod before closing brace
                # Remove existing installMethod if present, then add new one
                content=$(echo "$content" | sed 's/,"installMethod":"[^"]*"//g' | sed 's/"installMethod":"[^"]*",//g' | sed 's/"installMethod":"[^"]*"//g')
                # Add installMethod before final }
                echo "$content" | sed 's/}$/,"installMethod":"'"$method"'"}/' > "$config_file"
            fi
        fi
    else
        echo "{\"installMethod\":\"$method\"}" > "$config_file"
    fi

    log "Install method '$method' saved to config"
}

# Prompt user for install method choice
prompt_install_method() {
    if [[ "$AUTO_YES" == true ]]; then
        # Default to bun for auto mode
        INSTALL_METHOD="bun"
        return
    fi

    echo
    echo -e "${BOLD}How would you like to install Genie CLI?${NC}"
    echo
    echo "  1) source  - Clone from GitHub (developer mode)"
    echo "  2) npm     - Install via npm -g"
    echo "  3) bun     - Install via bun -g (recommended)"
    echo
    echo -en "${YELLOW}?${NC} Choose [1-3] (default: 3): "
    read -r choice

    case "$choice" in
        1) INSTALL_METHOD="source" ;;
        2) INSTALL_METHOD="npm" ;;
        *) INSTALL_METHOD="bun" ;;
    esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Installation Methods
# ─────────────────────────────────────────────────────────────────────────────

# Quick install: npm/bun global install (requires node/bun already installed)
install_quick() {
    header "Quick Install"

    if ! check_command node && ! check_command bun; then
        error "Quick install requires Node.js or Bun to be installed."
        info "Use 'full' mode to install all dependencies: curl ... | bash -s -- full"
        exit 3
    fi

    log "Installing $PACKAGE_NAME globally..."

    local version_arg=""
    if [[ "$TARGET_VERSION" != "stable" && "$TARGET_VERSION" != "latest" ]]; then
        version_arg="@$TARGET_VERSION"
    elif [[ "$TARGET_VERSION" == "latest" ]]; then
        version_arg="@latest"
    fi

    local used_method=""
    if check_command bun; then
        run bun install -g "${PACKAGE_NAME}${version_arg}"
        used_method="bun"
    elif check_command npm; then
        run npm install -g "${PACKAGE_NAME}${version_arg}"
        used_method="npm"
    fi

    # Save install method to config
    write_install_method "$used_method"

    success "Genie CLI installed via package manager"
}

# Full install: install all dependencies first, then npm/bun global install
install_full() {
    header "Full Install (with dependencies)"

    CLEANUP_NEEDED=true

    header "Installing prerequisites..."

    install_git_if_needed
    install_node_if_needed
    install_bun_if_needed
    install_tmux_if_needed || true
    install_jq_if_needed || true
    install_rg_if_needed || true
    install_claude_if_needed || true

    header "Installing Genie CLI..."

    local version_arg=""
    if [[ "$TARGET_VERSION" != "stable" && "$TARGET_VERSION" != "latest" ]]; then
        version_arg="@$TARGET_VERSION"
    elif [[ "$TARGET_VERSION" == "latest" ]]; then
        version_arg="@latest"
    fi

    log "Installing $PACKAGE_NAME globally..."

    local used_method=""
    if check_command bun; then
        run bun install -g "${PACKAGE_NAME}${version_arg}"
        used_method="bun"
    elif check_command npm; then
        run npm install -g "${PACKAGE_NAME}${version_arg}"
        used_method="npm"
    fi

    # Save install method to config
    write_install_method "$used_method"

    CLEANUP_NEEDED=false
    success "Genie CLI installed"
}

# Source install: clone repo and build locally (developer mode)
install_source() {
    header "Source Install (developer mode)"

    CLEANUP_NEEDED=true

    header "Installing prerequisites..."

    install_git_if_needed
    install_node_if_needed
    install_bun_if_needed
    install_tmux_if_needed || true
    install_jq_if_needed || true
    install_rg_if_needed || true
    install_claude_if_needed || true

    header "Cloning repository..."

    if [[ -d "$GENIE_SRC" ]]; then
        if confirm "Existing source installation found at $GENIE_SRC. Remove and reinstall?"; then
            rm -rf "$GENIE_SRC"
        else
            error "Installation cancelled"
            exit 1
        fi
    fi

    mkdir -p "$GENIE_HOME"
    log "Cloning $REPO_URL..."
    run git clone "$REPO_URL" "$GENIE_SRC"

    if [[ "$TARGET_VERSION" != "stable" && "$TARGET_VERSION" != "latest" ]]; then
        log "Checking out version $TARGET_VERSION..."
        cd "$GENIE_SRC"
        git checkout "v$TARGET_VERSION" 2>/dev/null || git checkout "$TARGET_VERSION"
    fi

    header "Building..."

    cd "$GENIE_SRC"
    run bun install
    run bun run build

    header "Installing binaries..."

    install_binaries

    # Save install method to config
    write_install_method "source"

    CLEANUP_NEEDED=false
    success "Genie CLI built and installed from source"
}

# Update existing installation
install_update() {
    header "Update"

    # Detect installation type
    local install_type=""

    if [[ -d "$GENIE_SRC/.git" ]]; then
        install_type="source"
    elif check_command genie; then
        # Check if installed via npm/bun
        local genie_path
        genie_path=$(which genie 2>/dev/null || true)
        if [[ "$genie_path" == *"node_modules"* || "$genie_path" == *".bun"* ]]; then
            install_type="npm"
        elif [[ "$genie_path" == "$LOCAL_BIN/genie" || "$genie_path" == "$GENIE_BIN/"* ]]; then
            install_type="source"
        else
            install_type="npm"
        fi
    else
        error "No existing Genie CLI installation found"
        info "Run without 'update' to perform a fresh install"
        exit 1
    fi

    log "Detected installation type: $install_type"

    case "$install_type" in
        source)
            update_source
            ;;
        npm)
            update_npm
            ;;
    esac
}

update_source() {
    log "Updating source installation..."

    if [[ ! -d "$GENIE_SRC/.git" ]]; then
        error "Source directory not found at $GENIE_SRC"
        exit 1
    fi

    cd "$GENIE_SRC"

    log "Pulling latest changes..."
    run git fetch origin
    run git reset --hard origin/main

    if [[ "$TARGET_VERSION" != "stable" && "$TARGET_VERSION" != "latest" ]]; then
        log "Checking out version $TARGET_VERSION..."
        git checkout "v$TARGET_VERSION" 2>/dev/null || git checkout "$TARGET_VERSION"
    fi

    log "Rebuilding..."
    run bun install
    run bun run build

    install_binaries

    success "Source installation updated"
}

update_npm() {
    log "Updating npm/bun installation..."

    local version_arg=""
    if [[ "$TARGET_VERSION" != "stable" && "$TARGET_VERSION" != "latest" ]]; then
        version_arg="@$TARGET_VERSION"
    elif [[ "$TARGET_VERSION" == "latest" ]]; then
        version_arg="@latest"
    fi

    if check_command bun; then
        run bun install -g "${PACKAGE_NAME}${version_arg}"
    elif check_command npm; then
        run npm install -g "${PACKAGE_NAME}${version_arg}"
    else
        error "Neither bun nor npm found"
        exit 3
    fi

    success "Package installation updated"
}

# Auto-detect best installation mode
install_auto() {
    log "Auto-detecting best installation mode..."

    # Check for existing installation
    if [[ -d "$GENIE_SRC/.git" ]]; then
        log "Found existing source installation"
        INSTALL_MODE="update"
        install_update
        return
    fi

    if check_command genie; then
        log "Found existing genie installation"
        INSTALL_MODE="update"
        install_update
        return
    fi

    # Fresh install: prompt user for install method
    prompt_install_method

    case "$INSTALL_METHOD" in
        source)
            INSTALL_MODE="source"
            install_source
            ;;
        npm)
            if check_command npm; then
                INSTALL_MODE="quick"
                install_quick_npm
            else
                log "npm not found, using full install"
                INSTALL_MODE="full"
                install_full
            fi
            ;;
        bun)
            if check_command bun; then
                INSTALL_MODE="quick"
                install_quick_bun
            else
                log "bun not found, using full install"
                INSTALL_MODE="full"
                install_full
            fi
            ;;
    esac
}

# Quick install via bun only
install_quick_bun() {
    header "Quick Install (bun)"

    if ! check_command bun; then
        error "Bun is not installed."
        info "Use 'full' mode to install all dependencies: curl ... | bash -s -- full"
        exit 3
    fi

    log "Installing $PACKAGE_NAME globally via bun..."

    local version_arg=""
    if [[ "$TARGET_VERSION" != "stable" && "$TARGET_VERSION" != "latest" ]]; then
        version_arg="@$TARGET_VERSION"
    elif [[ "$TARGET_VERSION" == "latest" ]]; then
        version_arg="@latest"
    fi

    run bun install -g "${PACKAGE_NAME}${version_arg}"

    # Save install method to config
    write_install_method "bun"

    success "Genie CLI installed via bun"
}

# Quick install via npm only
install_quick_npm() {
    header "Quick Install (npm)"

    if ! check_command npm; then
        error "npm is not installed."
        info "Use 'full' mode to install all dependencies: curl ... | bash -s -- full"
        exit 3
    fi

    log "Installing $PACKAGE_NAME globally via npm..."

    local version_arg=""
    if [[ "$TARGET_VERSION" != "stable" && "$TARGET_VERSION" != "latest" ]]; then
        version_arg="@$TARGET_VERSION"
    elif [[ "$TARGET_VERSION" == "latest" ]]; then
        version_arg="@latest"
    fi

    run npm install -g "${PACKAGE_NAME}${version_arg}"

    # Save install method to config
    write_install_method "npm"

    success "Genie CLI installed via npm"
}

# ─────────────────────────────────────────────────────────────────────────────
# Binary Installation (for source installs)
# ─────────────────────────────────────────────────────────────────────────────

install_binaries() {
    log "Installing binaries..."

    mkdir -p "$GENIE_BIN"
    mkdir -p "$LOCAL_BIN"

    # Copy built files
    cp "$GENIE_SRC/dist/genie.js" "$GENIE_BIN/"
    cp "$GENIE_SRC/dist/term.js" "$GENIE_BIN/"
    cp "$GENIE_SRC/dist/claudio.js" "$GENIE_BIN/"
    chmod +x "$GENIE_BIN"/*.js

    # Create symlinks
    ln -sf "$GENIE_BIN/genie.js" "$LOCAL_BIN/genie"
    ln -sf "$GENIE_BIN/term.js" "$LOCAL_BIN/term"
    ln -sf "$GENIE_BIN/claudio.js" "$LOCAL_BIN/claudio"

    success "Binaries installed to $GENIE_BIN"
}

# ─────────────────────────────────────────────────────────────────────────────
# Post-Install
# ─────────────────────────────────────────────────────────────────────────────

ensure_path() {
    local needs_path=false
    local shell_profile=""

    # Check various PATH locations
    if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
        needs_path=true
    fi

    # Also check for bun path
    if [[ -d "$HOME/.bun/bin" && ":$PATH:" != *":$HOME/.bun/bin:"* ]]; then
        needs_path=true
    fi

    if [[ "$needs_path" == true ]]; then
        # Detect shell profile
        if [[ -n "${ZSH_VERSION:-}" ]] || [[ "$SHELL" == *"zsh"* ]]; then
            shell_profile="$HOME/.zshrc"
        elif [[ -n "${BASH_VERSION:-}" ]] || [[ "$SHELL" == *"bash"* ]]; then
            if [[ -f "$HOME/.bashrc" ]]; then
                shell_profile="$HOME/.bashrc"
            else
                shell_profile="$HOME/.bash_profile"
            fi
        fi

        echo
        warn "Some paths may not be in your PATH"
        echo
        echo "Add these to your shell profile ($shell_profile):"
        echo -e "${CYAN}  export PATH=\"\$HOME/.local/bin:\$HOME/.bun/bin:\$PATH\"${NC}"
        echo
        echo "Then reload your shell:"
        echo -e "${CYAN}  source $shell_profile${NC}"
        echo
    fi
}

run_setup() {
    # Run genie setup if available
    if check_command genie; then
        log "Running genie setup..."
        genie setup --quick 2>/dev/null || true
    elif [[ -x "$GENIE_BIN/genie.js" ]]; then
        log "Running genie setup..."
        "$GENIE_BIN/genie.js" setup --quick 2>/dev/null || true
    fi
}

print_success() {
    echo
    echo -e "${DIM}────────────────────────────────────${NC}"
    echo -e "${GREEN}${BOLD}Genie CLI installed successfully!${NC}"
    echo -e "${DIM}────────────────────────────────────${NC}"
    echo
    echo "Commands available:"
    echo -e "  ${CYAN}genie${NC}   - Setup and utilities"
    echo -e "  ${CYAN}term${NC}    - Terminal orchestration"
    echo -e "  ${CYAN}claudio${NC} - Claude profile manager"
    echo
    echo "Get started:"
    echo -e "  ${CYAN}genie --help${NC}"
    echo -e "  ${CYAN}term --help${NC}"
    echo
}

# ─────────────────────────────────────────────────────────────────────────────
# Argument Parsing
# ─────────────────────────────────────────────────────────────────────────────

print_usage() {
    cat <<EOF
Genie CLI Installer v$VERSION

Usage:
  curl -fsSL $RAW_REPO_URL/main/install.sh | bash
  curl ... | bash -s -- [MODE] [OPTIONS]

Modes:
  auto      Auto-detect best installation method (default)
  quick     Use bun/npm global install (requires node/bun)
  full      Install all dependencies first, then global install
  source    Clone repo and build locally (developer mode)
  update    Update existing installation

Options:
  --version=VERSION   Install specific version (stable, latest, or semver)
  --yes, -y           Auto-approve all prompts
  --help, -h          Show this help message

Examples:
  # Fresh install (auto-detect)
  curl -fsSL $RAW_REPO_URL/main/install.sh | bash

  # Quick install (requires bun/npm)
  curl ... | bash -s -- quick

  # Full install with all dependencies
  curl ... | bash -s -- full

  # Developer mode (source build)
  curl ... | bash -s -- source

  # Update existing installation
  curl ... | bash -s -- update

  # Install specific version
  curl ... | bash -s -- --version=0.260202.0002

  # Auto-approve prompts
  curl ... | bash -s -- full --yes
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            quick|full|source|update|auto)
                INSTALL_MODE="$1"
                ;;
            --version=*)
                TARGET_VERSION="${1#*=}"
                ;;
            --yes|-y)
                AUTO_YES=true
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

    # Initialize
    init_downloader
    detect_platform

    # Create temp directory
    TEMP_DIR=$(mktemp -d)

    # Route to appropriate installer
    case "$INSTALL_MODE" in
        auto)
            install_auto
            ;;
        quick)
            install_quick
            ;;
        full)
            install_full
            ;;
        source)
            install_source
            ;;
        update)
            install_update
            ;;
    esac

    # Post-install steps
    if [[ "$INSTALL_MODE" == "source" ]]; then
        ensure_path
    fi

    # Run setup for non-update installs
    if [[ "$INSTALL_MODE" != "update" ]]; then
        run_setup
    fi

    print_success
}

main "$@"
