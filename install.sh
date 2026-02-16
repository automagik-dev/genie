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
readonly CLAUDE_PLUGINS_DIR="$HOME/.claude/plugins"
readonly PLUGIN_SYMLINK="$CLAUDE_PLUGINS_DIR/automagik-genie"

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
LOCAL_PATH=""  # If set, use local source instead of npm
AUTO_LOCAL_DETECTED=false  # True if local mode was auto-detected
DEV_MODE=false  # If true, link plugins instead of copying (for development)

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
    local response=""
    echo -en "${YELLOW}?${NC} $prompt [Y/n] "

    # Prefer /dev/tty for interactive installs, but fall back to stdin (CI/heredoc).
    # Some environments expose /dev/tty but make it unreadable; suppress that noise.
    if [[ -e /dev/tty ]]; then
        read -r response < /dev/tty 2>/dev/null || true
    fi
    if [[ -z "${response:-}" ]]; then
        read -r response 2>/dev/null || response=""
    fi

    [[ -z "$response" || "$response" =~ ^[Yy]$ ]]
}

# Prompt user for confirmation (N is default)
confirm_no() {
    local prompt="$1"
    local response=""
    echo -en "${YELLOW}?${NC} $prompt [y/N] "

    if [[ -e /dev/tty ]]; then
        read -r response < /dev/tty 2>/dev/null || true
    fi
    if [[ -z "${response:-}" ]]; then
        read -r response 2>/dev/null || response=""
    fi

    [[ "$response" =~ ^[Yy]$ ]]
}

# ─────────────────────────────────────────────────────────────────────────────
# Symlink Detection and Repair
# ─────────────────────────────────────────────────────────────────────────────

# Check if a path is a broken symlink
is_broken_symlink() {
    local path="$1"
    # -L checks if it's a symlink, ! -e checks if target doesn't exist
    [[ -L "$path" && ! -e "$path" ]]
}

# Check if a path is a valid symlink pointing to an existing directory
is_valid_symlink() {
    local path="$1"
    [[ -L "$path" && -d "$path" ]]
}

# Check and repair broken plugin symlink
check_and_repair_symlink() {
    if is_broken_symlink "$PLUGIN_SYMLINK"; then
        local target
        target=$(readlink "$PLUGIN_SYMLINK" 2>/dev/null || echo "unknown")
        warn "Broken symlink detected: $PLUGIN_SYMLINK -> $target"
        warn "The symlink target no longer exists"
        echo
        if confirm "Repair broken symlink?"; then
            rm -f "$PLUGIN_SYMLINK"
            success "Broken symlink removed (will be recreated during install)"
            return 0
        else
            warn "Keeping broken symlink (this may cause issues)"
            return 1
        fi
    fi
    return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# OpenClaw Config Repair
# ─────────────────────────────────────────────────────────────────────────────

readonly OPENCLAW_CONFIG="$HOME/.openclaw/openclaw.json"

# Check if OpenClaw config has stale automagik-genie paths
check_openclaw_stale_paths() {
    if [[ ! -f "$OPENCLAW_CONFIG" ]]; then
        return 1  # No config, nothing to repair
    fi

    if ! check_command jq; then
        return 1  # Can't parse without jq
    fi

    # Get all plugin paths from config
    local paths
    paths=$(jq -r '.plugins.load.paths[]? // empty' "$OPENCLAW_CONFIG" 2>/dev/null || true)

    for path in $paths; do
        if [[ "$path" == *"automagik-genie"* ]] && [[ ! -f "$path" ]]; then
            return 0  # Found stale path
        fi
    done

    return 1  # No stale paths
}

# Get the stale automagik-genie path from OpenClaw config
get_openclaw_stale_path() {
    if [[ ! -f "$OPENCLAW_CONFIG" ]] || ! check_command jq; then
        return
    fi

    local paths
    paths=$(jq -r '.plugins.load.paths[]? // empty' "$OPENCLAW_CONFIG" 2>/dev/null || true)

    for path in $paths; do
        if [[ "$path" == *"automagik-genie"* ]] && [[ ! -f "$path" ]]; then
            echo "$path"
            return
        fi
    done
}

# Repair stale OpenClaw plugin paths
repair_openclaw_stale_paths() {
    local stale_path new_path plugin_dir

    stale_path=$(get_openclaw_stale_path)
    if [[ -z "$stale_path" ]]; then
        return 0  # Nothing to repair
    fi

    # Determine the new correct path
    if [[ -n "$LOCAL_PATH" ]]; then
        plugin_dir="$LOCAL_PATH/plugins/automagik-genie"
        new_path="$plugin_dir/automagik-genie.ts"
    else
        return 1  # Can't determine new path without LOCAL_PATH
    fi

    if [[ ! -f "$new_path" ]]; then
        warn "New plugin path doesn't exist: $new_path"
        return 1
    fi

    warn "Stale OpenClaw plugin path detected in config"
    warn "  Old: $stale_path"
    warn "  New: $new_path"
    echo

    if confirm "Update OpenClaw config with new path?"; then
        # Use jq to update the path
        local tmp_config
        tmp_config=$(mktemp)

        if jq --arg old "$stale_path" --arg new "$new_path" '
            .plugins.load.paths = [.plugins.load.paths[]? | if . == $old then $new else . end]
        ' "$OPENCLAW_CONFIG" > "$tmp_config" 2>/dev/null; then
            mv "$tmp_config" "$OPENCLAW_CONFIG"
            success "OpenClaw config updated"
            return 0
        else
            rm -f "$tmp_config"
            error "Failed to update OpenClaw config"
            return 1
        fi
    else
        warn "Keeping stale path (OpenClaw plugin install may fail)"
        return 1
    fi
}

# Remove automagik-genie paths from OpenClaw config (for uninstall)
remove_openclaw_plugin_paths() {
    if [[ ! -f "$OPENCLAW_CONFIG" ]] || ! check_command jq; then
        return 0
    fi

    local tmp_config
    tmp_config=$(mktemp)

    # Remove any paths containing automagik-genie
    if jq '
        .plugins.load.paths = [.plugins.load.paths[]? | select(contains("automagik-genie") | not)] |
        del(.plugins.entries["automagik-genie"])
    ' "$OPENCLAW_CONFIG" > "$tmp_config" 2>/dev/null; then
        mv "$tmp_config" "$OPENCLAW_CONFIG"
        return 0
    else
        rm -f "$tmp_config"
        return 1
    fi
}

# Verify symlink was created successfully
verify_symlink() {
    local symlink_path="$1"
    local expected_target="$2"

    if [[ ! -L "$symlink_path" ]]; then
        error "Symlink was not created: $symlink_path"
        return 1
    fi

    if [[ ! -d "$symlink_path" ]]; then
        error "Symlink points to non-existent directory: $(readlink "$symlink_path")"
        return 1
    fi

    local actual_target
    actual_target=$(readlink -f "$symlink_path" 2>/dev/null)
    expected_target=$(cd "$expected_target" 2>/dev/null && pwd)

    if [[ "$actual_target" != "$expected_target" ]]; then
        warn "Symlink target mismatch"
        warn "  Expected: $expected_target"
        warn "  Actual:   $actual_target"
        return 1
    fi

    success "Symlink verified: $symlink_path -> $actual_target"
    return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Source Directory Auto-Detection
# ─────────────────────────────────────────────────────────────────────────────

# Check if a directory is the genie-cli source directory
is_genie_source_dir() {
    local dir="$1"

    # Must have package.json
    if [[ ! -f "$dir/package.json" ]]; then
        return 1
    fi

    # package.json must contain @automagik/genie
    if grep -q '"name"[[:space:]]*:[[:space:]]*"@automagik/genie"' "$dir/package.json" 2>/dev/null; then
        return 0
    fi

    return 1
}

# Auto-detect if we're running from a genie-cli source directory
auto_detect_source_dir() {
    # Get the directory where install.sh is located
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

    if is_genie_source_dir "$script_dir"; then
        LOCAL_PATH="$script_dir"
        AUTO_LOCAL_DETECTED=true
        return 0
    fi

    return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# Version Detection
# ─────────────────────────────────────────────────────────────────────────────

# Get installed genie-cli version
get_installed_version() {
    local version=""

    # Try bun first (check global packages)
    if check_command bun; then
        version=$(bun pm ls -g 2>/dev/null | grep "$PACKAGE_NAME" | grep -o '@[0-9][^[:space:]]*' | tr -d '@' || true)
    fi

    # Fallback to npm
    if [[ -z "$version" ]] && check_command npm; then
        version=$(npm ls -g "$PACKAGE_NAME" --depth=0 2>/dev/null | grep "$PACKAGE_NAME" | grep -o '@[0-9][^[:space:]]*' | tr -d '@' || true)
    fi

    echo "$version"
}

# Get latest version from npm registry
get_latest_version() {
    local url="https://registry.npmjs.org/$PACKAGE_NAME/latest"
    case "$DOWNLOADER" in
        curl)
            curl -fsSL "$url" 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4
            ;;
        wget)
            wget -qO- "$url" 2>/dev/null | grep -o '"version":"[^"]*"' | cut -d'"' -f4
            ;;
    esac
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

# Ensure bun's global bin directory is in PATH
# This is needed after installing global packages via bun
ensure_bun_in_path() {
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    if [[ ":$PATH:" != *":$BUN_INSTALL/bin:"* ]]; then
        export PATH="$BUN_INSTALL/bin:$PATH"
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
    # In local source mode (--local), do not rely on Claude marketplaces.
    # Link the local plugin directory into ~/.claude/plugins instead.
    if [[ -n "$LOCAL_PATH" ]]; then
        local plugin_dir="$LOCAL_PATH/plugins/automagik-genie"
        if [[ -d "$plugin_dir" ]]; then
            log "Linking automagik-genie Claude Code plugin from local source..."
            mkdir -p "$CLAUDE_PLUGINS_DIR"
            rm -f "$PLUGIN_SYMLINK"
            ln -sf "$plugin_dir" "$PLUGIN_SYMLINK"
            if verify_symlink "$PLUGIN_SYMLINK" "$plugin_dir"; then
                success "automagik-genie Claude Code plugin linked"
                return 0
            else
                warn "Failed to create valid symlink for Claude Code plugin"
                return 1
            fi
        else
            warn "Local plugin directory not found: $plugin_dir"
            return 1
        fi
    fi
}

# Install the OpenClaw plugin (skills become available globally)
install_openclaw_plugin() {
    if ! check_command openclaw; then
        warn "openclaw command not found"
        return 1
    fi

    if openclaw plugins list 2>/dev/null | grep -q "automagik-genie"; then
        success "automagik-genie OpenClaw plugin already discovered"
        return 0
    fi

    local pkg_dir plugin_dir

    if [[ -n "$LOCAL_PATH" ]]; then
        pkg_dir="$LOCAL_PATH"
    else
        # Locate global npm install directory
        if check_command npm; then
            local npm_root
            npm_root=$(npm root -g 2>/dev/null || true)
            if [[ -n "$npm_root" && -d "$npm_root/@automagik/genie" ]]; then
                pkg_dir="$npm_root/@automagik/genie"
            fi
        fi

        # Best-effort bun global path
        if [[ -z "${pkg_dir:-}" && -n "${BUN_INSTALL:-}" ]]; then
            if [[ -d "$BUN_INSTALL/install/global/node_modules/@automagik/genie" ]]; then
                pkg_dir="$BUN_INSTALL/install/global/node_modules/@automagik/genie"
            fi
        fi
    fi

    if [[ -z "${pkg_dir:-}" ]]; then
        warn "Could not locate installed Genie package directory"
        warn "Tip: re-run with --local /path/to/genie-cli"
        return 1
    fi

    plugin_dir="$pkg_dir/plugins/automagik-genie"
    local plugin_file="$plugin_dir/automagik-genie.ts"

    if [[ ! -f "$plugin_dir/openclaw.plugin.json" ]]; then
        warn "OpenClaw plugin manifest not found: $plugin_dir/openclaw.plugin.json"
        return 1
    fi

    if [[ ! -f "$plugin_file" ]]; then
        warn "OpenClaw plugin entrypoint not found: $plugin_file"
        return 1
    fi

    if $DEV_MODE; then
        log "Linking OpenClaw plugin (dev mode)..."
        openclaw plugins install -l "$plugin_dir" \
            && success "OpenClaw plugin linked" \
            || warn "OpenClaw plugin link failed"
    else
        log "Installing OpenClaw plugin (copy mode)..."
        openclaw plugins install "$plugin_dir" \
            && success "OpenClaw plugin installed" \
            || warn "OpenClaw plugin install failed"
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Genie CLI Installation
# ─────────────────────────────────────────────────────────────────────────────

install_genie_cli() {
    log "Installing $PACKAGE_NAME..."

    # Local installation mode - use source directly
    if [[ -n "$LOCAL_PATH" ]]; then
        if $AUTO_LOCAL_DETECTED; then
            info "Using local source mode (auto-detected from source directory)"
        else
            info "Using local source mode"
        fi
        log "Source path: $LOCAL_PATH"

        if [[ ! -d "$LOCAL_PATH" ]]; then
            error "Local path does not exist: $LOCAL_PATH"
            exit 1
        fi

        pushd "$LOCAL_PATH" > /dev/null

        # Build
        log "Building from source..."
        if check_command bun; then
            bun install
            bun run build
        else
            npm install
            npm run build
        fi

        # Link globally (npm link creates proper global bin symlinks; bun link does not)
        log "Linking globally..."
        npm link

        # Also set up Claude Code plugin to use local version
        local plugin_dir="$LOCAL_PATH/plugins/automagik-genie"
        if [[ -d "$plugin_dir" ]]; then
            log "Linking Claude Code plugin..."
            mkdir -p "$CLAUDE_PLUGINS_DIR"
            rm -f "$PLUGIN_SYMLINK"
            ln -sf "$plugin_dir" "$PLUGIN_SYMLINK"

            # Verify the symlink was created correctly
            if ! verify_symlink "$PLUGIN_SYMLINK" "$plugin_dir"; then
                error "Failed to create valid symlink for Claude Code plugin"
                exit 1
            fi

            # Also register as OpenClaw plugin if available
            if check_command openclaw; then
                if [[ -f "$plugin_dir/openclaw.plugin.json" ]]; then
                    if $DEV_MODE; then
                        log "Linking OpenClaw plugin (dev mode)..."
                        openclaw plugins install -l "$plugin_dir" 2>/dev/null \
                            && success "OpenClaw plugin linked" \
                            || warn "OpenClaw plugin link failed (may already be installed)"
                    else
                        log "Installing OpenClaw plugin (copy mode)..."
                        openclaw plugins install "$plugin_dir" 2>/dev/null \
                            && success "OpenClaw plugin installed" \
                            || warn "OpenClaw plugin install failed (may already be installed)"
                    fi
                else
                    warn "OpenClaw plugin manifest not found: $plugin_dir/openclaw.plugin.json"
                fi
            fi
        else
            warn "Plugin directory not found: $plugin_dir"
            warn "Claude Code plugin symlink was not created"
        fi

        popd > /dev/null
        success "$PACKAGE_NAME installed from local source"
        return
    fi

    if check_command bun; then
        bun install -g "$PACKAGE_NAME"
        ensure_bun_in_path
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
    ensure_bun_in_path
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
    # ─── Prerequisites ───
    header "Checking prerequisites..."
    install_git_if_needed
    install_node_if_needed
    install_bun_if_needed
    install_tmux_if_needed
    install_jq_if_needed
    install_rg_if_needed
    install_claude_if_needed

    # ─── Genie CLI Install/Update ───
    header "Checking Genie CLI..."
    local installed_version latest_version
    installed_version=$(get_installed_version)
    latest_version=$(get_latest_version)

    if [[ -n "$installed_version" ]]; then
        log "Genie CLI ${BOLD}$installed_version${NC} installed"
        if [[ -n "$latest_version" ]]; then
            if [[ "$installed_version" == "$latest_version" ]]; then
                success "Genie CLI is up to date"
            else
                log "Latest version: ${BOLD}$latest_version${NC}"
                echo
                if confirm "Update Genie CLI?"; then
                    install_genie_cli
                    success "Genie CLI updated to $latest_version"
                else
                    info "Skipping update"
                fi
            fi
        else
            warn "Could not check latest version"
        fi
    else
        install_genie_cli
    fi

    # ─── Configuration Wizard ───
    header "Configuration"
    echo -e "${DIM}────────────────────────────────────${NC}"

    # Plugin for Claude Code
    if check_command claude; then
        info "Adds skills, agents, and hooks to Claude Code"
        if confirm "Install Genie plugin for Claude Code?"; then
            install_plugin_if_needed
        fi
        echo
    fi

    # Plugin for OpenClaw
    if check_command openclaw; then
        info "Adds skills (global /brainstorm, /wish, etc.) to OpenClaw"
        if confirm "Install Genie plugin for OpenClaw?"; then
            install_openclaw_plugin
        fi
        echo
    fi

    # Claudio profiles
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

    local removed_something=false

    # 1. Genie CLI package (default: yes)
    if confirm "Remove Genie CLI package?"; then
        if check_command bun; then
            bun remove -g "$PACKAGE_NAME" 2>/dev/null || true
        fi
        if check_command npm; then
            npm uninstall -g "$PACKAGE_NAME" 2>/dev/null || true
        fi
        success "Genie CLI removed"
        removed_something=true
    else
        info "Keeping Genie CLI"
    fi

    # 2. Claude Code plugin symlink (default: yes)
    if [[ -e "$PLUGIN_SYMLINK" || -L "$PLUGIN_SYMLINK" ]]; then
        if confirm "Remove Claude Code plugin symlink?"; then
            rm -rf "$PLUGIN_SYMLINK"
            success "Claude Code plugin symlink removed"
            removed_something=true
        else
            info "Keeping Claude Code plugin symlink"
        fi
    fi

    # Also try claude plugin uninstall for marketplace-installed plugins
    if check_command claude && claude plugin list 2>/dev/null | grep -q "automagik-genie"; then
        if confirm "Unregister Claude Code plugin from marketplace?"; then
            claude plugin uninstall namastexlabs/automagik-genie 2>/dev/null || true
            success "Claude Code plugin unregistered"
            removed_something=true
        else
            info "Keeping Claude Code plugin registration"
        fi
    fi

    # 3. OpenClaw plugin (default: yes)
    if check_command openclaw && openclaw plugins list 2>/dev/null | grep -q "automagik-genie"; then
        if confirm "Remove OpenClaw plugin?"; then
            # OpenClaw CLI currently has install/enable/disable but no uninstall.
            # Installed plugins typically live under ~/.openclaw/extensions/<id>.
            local ext_dir="$HOME/.openclaw/extensions/automagik-genie"

            # Best effort: disable in config first (if present)
            openclaw plugins disable automagik-genie 2>/dev/null || true

            if [[ -e "$ext_dir" || -L "$ext_dir" ]]; then
                rm -rf "$ext_dir"
            fi

            # Also remove paths from OpenClaw config
            remove_openclaw_plugin_paths

            success "OpenClaw plugin removed"
            removed_something=true
        else
            info "Keeping OpenClaw plugin"
        fi
    fi

    # 4. Config directory (default: no - preserve settings)
    if [[ -d "$GENIE_HOME" ]]; then
        if confirm_no "Remove ~/.genie config directory?"; then
            rm -rf "$GENIE_HOME"
            success "Configuration removed"
            removed_something=true
        else
            info "Keeping config (reinstall will preserve settings)"
        fi
    fi

    echo
    if $removed_something; then
        success "Done"
    else
        info "Nothing removed"
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Installation Verification
# ─────────────────────────────────────────────────────────────────────────────

# Detect the user's shell profile file
get_shell_profile() {
    local shell_name
    shell_name=$(basename "${SHELL:-/bin/bash}")

    case "$shell_name" in
        zsh)
            if [[ -f "$HOME/.zshrc" ]]; then
                echo "$HOME/.zshrc"
            else
                echo "$HOME/.zprofile"
            fi
            ;;
        bash)
            if [[ -f "$HOME/.bashrc" ]]; then
                echo "$HOME/.bashrc"
            elif [[ -f "$HOME/.bash_profile" ]]; then
                echo "$HOME/.bash_profile"
            else
                echo "$HOME/.profile"
            fi
            ;;
        *)
            echo "$HOME/.profile"
            ;;
    esac
}

# Get the bin directory where global packages are installed
get_global_bin_dir() {
    if check_command bun; then
        echo "${BUN_INSTALL:-$HOME/.bun}/bin"
    elif check_command npm; then
        npm config get prefix 2>/dev/null | xargs -I{} echo "{}/bin"
    else
        echo ""
    fi
}

# Verify that genie and term commands are accessible
verify_installation() {
    local commands_found=true
    local bin_dir
    bin_dir=$(get_global_bin_dir)

    echo
    header "Verifying installation..."

    # Check genie command
    if check_command genie; then
        success "genie command is available"
    else
        if [[ -n "$bin_dir" && -x "$bin_dir/genie" ]]; then
            warn "genie is installed at $bin_dir/genie but not in PATH"
            commands_found=false
        else
            warn "genie command not found"
            commands_found=false
        fi
    fi

    # Check term command
    if check_command term; then
        success "term command is available"
    else
        if [[ -n "$bin_dir" && -x "$bin_dir/term" ]]; then
            warn "term is installed at $bin_dir/term but not in PATH"
            commands_found=false
        else
            warn "term command not found"
            commands_found=false
        fi
    fi

    if ! $commands_found; then
        local profile
        profile=$(get_shell_profile)

        echo
        warn "Commands are installed but not yet in your PATH"
        echo
        info "To use genie and term, do ONE of the following:"
        echo
        echo -e "  ${BOLD}Option 1:${NC} Restart your terminal"
        echo
        echo -e "  ${BOLD}Option 2:${NC} Source your shell profile:"
        echo -e "    ${DIM}source $profile${NC}"
        echo
        if [[ -n "$bin_dir" ]]; then
            echo -e "  ${BOLD}Option 3:${NC} Add to PATH manually (if not already there):"
            echo -e "    ${DIM}export PATH=\"$bin_dir:\$PATH\"${NC}"
            echo
        fi
        return 1
    fi

    return 0
}

# ─────────────────────────────────────────────────────────────────────────────
# Success Message
# ─────────────────────────────────────────────────────────────────────────────

print_success() {
    local verification_passed=true

    # Run verification to check if commands are accessible
    if ! verify_installation; then
        verification_passed=false
    fi

    echo
    echo -e "${DIM}────────────────────────────────────${NC}"
    echo -e "${GREEN}${BOLD}Genie CLI installed successfully!${NC}"
    echo -e "${DIM}────────────────────────────────────${NC}"
    echo

    if $verification_passed; then
        echo -e "  Get started:"
        echo -e "    ${DIM}genie --help${NC}"
        echo -e "    ${DIM}term --help${NC}"
        echo
    else
        echo -e "  ${YELLOW}After restarting your terminal, verify with:${NC}"
        echo -e "    ${DIM}genie --help${NC}"
        echo -e "    ${DIM}term --help${NC}"
        echo
    fi
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
  ./install.sh --local /path/to/genie-cli

Commands:
  (default)       Interactive install from npm
  uninstall       Remove Genie CLI and components
  --local PATH    Install from local source directory (for development)
  --dev, -d       Dev mode: link OpenClaw plugin instead of copying
  --help          Show this help message
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            uninstall)
                INSTALL_MODE="uninstall"
                ;;
            --local)
                shift
                if [[ $# -eq 0 ]]; then
                    error "--local requires a path argument"
                    exit 2
                fi
                LOCAL_PATH="$(cd "$1" && pwd)"  # Resolve to absolute path
                ;;
            --dev|-d)
                DEV_MODE=true
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

    # Auto-detect source directory if not explicitly set via --local
    if [[ -z "$LOCAL_PATH" ]] && [[ "$INSTALL_MODE" == "install" ]]; then
        if auto_detect_source_dir; then
            log "Detected genie-cli source directory"
        fi
    fi

    # Check for broken symlinks before installation
    if [[ "$INSTALL_MODE" == "install" ]]; then
        check_and_repair_symlink

        # Check for stale OpenClaw plugin paths
        if [[ -n "$LOCAL_PATH" ]] && check_openclaw_stale_paths; then
            repair_openclaw_stale_paths
        fi
    fi

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
