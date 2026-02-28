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
readonly PLUGIN_SYMLINK="$CLAUDE_PLUGINS_DIR/genie"
readonly CODEX_SKILLS_DIR="$HOME/.agents/skills"

# TTY detection for dual-mode (interactive vs agent)
if [[ -t 0 ]]; then
    INTERACTIVE=true
else
    INTERACTIVE=false
fi

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
PKG_DIR=""  # Set by locate_package_dir after install

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
    # Check new path
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

# Check if OpenClaw config has stale genie plugin paths
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
        if [[ "$path" == *"plugins/genie"* ]] && [[ ! -f "$path" ]]; then
            return 0  # Found stale path
        fi
    done

    return 1  # No stale paths
}

# Get the stale genie plugin path from OpenClaw config
get_openclaw_stale_path() {
    if [[ ! -f "$OPENCLAW_CONFIG" ]] || ! check_command jq; then
        return
    fi

    local paths
    paths=$(jq -r '.plugins.load.paths[]? // empty' "$OPENCLAW_CONFIG" 2>/dev/null || true)

    for path in $paths; do
        if [[ "$path" == *"plugins/genie"* ]] && [[ ! -f "$path" ]]; then
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
        plugin_dir="$LOCAL_PATH/plugins/genie"
        new_path="$plugin_dir/genie.ts"
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

# Remove genie paths from OpenClaw config (for uninstall)
remove_openclaw_plugin_paths() {
    if [[ ! -f "$OPENCLAW_CONFIG" ]] || ! check_command jq; then
        return 0
    fi

    local tmp_config
    tmp_config=$(mktemp)

    # Remove paths containing plugins/genie
    if jq '
        .plugins.load.paths = [.plugins.load.paths[]? | select(contains("plugins/genie") | not)] |
        del(.plugins.entries["genie"])
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

# ─────────────────────────────────────────────────────────────────────────────
# Package Directory Location
# ─────────────────────────────────────────────────────────────────────────────

locate_package_dir() {
    if [[ -n "$LOCAL_PATH" ]]; then
        PKG_DIR="$LOCAL_PATH"
        return 0
    fi

    # Try bun global
    local bun_global="${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules/@automagik/genie"
    if [[ -d "$bun_global" ]]; then
        PKG_DIR="$bun_global"
        return 0
    fi

    # Try npm global
    if check_command npm; then
        local npm_root
        npm_root=$(npm root -g 2>/dev/null || true)
        if [[ -n "$npm_root" && -d "$npm_root/@automagik/genie" ]]; then
            PKG_DIR="$npm_root/@automagik/genie"
            return 0
        fi
    fi

    PKG_DIR=""
    return 1
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
# Plugin Integration Offers
# ─────────────────────────────────────────────────────────────────────────────

offer_claude_plugin() {
    if ! check_command claude; then
        info "Claude Code not found — skipping plugin install"
        return 0
    fi

    info "Adds skills, agents, and hooks to Claude Code"
    if confirm "Install Genie plugin for Claude Code?"; then
        if [[ -n "$LOCAL_PATH" ]]; then
            # Local mode: symlink the plugin directory
            local plugin_dir="$PKG_DIR/plugins/genie"
            if [[ -d "$plugin_dir" ]]; then
                mkdir -p "$CLAUDE_PLUGINS_DIR"
                rm -f "$PLUGIN_SYMLINK"
                ln -sf "$plugin_dir" "$PLUGIN_SYMLINK"
                if verify_symlink "$PLUGIN_SYMLINK" "$plugin_dir"; then
                    success "Genie Claude Code plugin linked"
                else
                    warn "Failed to create valid symlink for Claude Code plugin"
                fi
            else
                warn "Plugin directory not found: $plugin_dir"
            fi
        else
            # Marketplace mode
            claude plugin marketplace add namastexlabs/genie-cli 2>/dev/null || true
            if claude plugin install genie@namastexlabs 2>/dev/null; then
                success "Genie Claude Code plugin installed"
            else
                warn "Plugin install failed — try: /plugin install genie@namastexlabs"
            fi
        fi
    fi
}

offer_openclaw_plugin() {
    if ! check_command openclaw; then
        info "OpenClaw not found — skipping plugin install"
        return 0
    fi

    if openclaw plugins list 2>/dev/null | grep -q "genie"; then
        success "Genie OpenClaw plugin already discovered"
        return 0
    fi

    if [[ -z "$PKG_DIR" ]]; then
        warn "Could not locate installed Genie package directory"
        return 1
    fi

    if [[ ! -f "$PKG_DIR/openclaw.plugin.json" ]]; then
        warn "OpenClaw plugin manifest not found: $PKG_DIR/openclaw.plugin.json"
        return 1
    fi

    info "Adds skills globally to OpenClaw"
    if confirm "Install Genie plugin for OpenClaw?"; then
        if $DEV_MODE; then
            log "Linking OpenClaw plugin (dev mode)..."
            if openclaw plugins install -l "$PKG_DIR"; then
                success "OpenClaw plugin linked"
            else
                warn "OpenClaw plugin link failed"
            fi
        else
            log "Installing OpenClaw plugin (copy mode)..."
            if openclaw plugins install "$PKG_DIR"; then
                success "OpenClaw plugin installed"
            else
                warn "OpenClaw plugin install failed"
            fi
        fi
    fi
}

offer_codex_skills() {
    local skills_source="$PKG_DIR/skills"
    if [[ ! -d "$skills_source" ]]; then
        warn "Skills directory not found in package"
        return 1
    fi

    info "Adds genie skills (/brainstorm, /wish, /work, etc.) to Codex/OpenCode"
    if confirm "Install Genie skills for Codex?"; then
        mkdir -p "$CODEX_SKILLS_DIR"
        local target="$CODEX_SKILLS_DIR/genie"
        ln -sf "$skills_source" "$target"
        success "Codex skills linked: $target -> $skills_source"
    fi
}

# ─────────────────────────────────────────────────────────────────────────────
# Agent Mode Output
# ─────────────────────────────────────────────────────────────────────────────

output_agent_prompt() {
    printf 'GENIE_INSTALL_COMPLETE\n'
    printf 'package_dir=%s\n' "$PKG_DIR"
    cat <<'AGENT_EOF'

To complete Genie setup, ask the user which integrations to enable:

1. **Claude Code Plugin** — Adds skills, agents, and hooks to Claude Code
   Commands:
   claude plugin marketplace add namastexlabs/genie-cli
   claude plugin install genie@namastexlabs

2. **OpenClaw Plugin** — Adds skills globally to OpenClaw
   Command:
AGENT_EOF
    printf '   openclaw plugins install %s\n' "$PKG_DIR"
    cat <<'AGENT_EOF'

3. **Codex/OpenCode Skills** — Adds skills to ~/.agents/skills/genie
   Command:
AGENT_EOF
    printf '   mkdir -p %s && ln -sf %s/skills %s/genie\n' "$CODEX_SKILLS_DIR" "$PKG_DIR" "$CODEX_SKILLS_DIR"
    cat <<'AGENT_EOF'

Ask the user which integrations they want, then run the corresponding commands.
AGENT_EOF
}

# ─────────────────────────────────────────────────────────────────────────────
# Main Install Flow
# ─────────────────────────────────────────────────────────────────────────────

run_install() {
    # ─── Prerequisites ───
    header "Checking prerequisites..."

    # Git only needed for local mode
    if [[ -n "$LOCAL_PATH" ]]; then
        install_git_if_needed
    fi

    install_bun_if_needed

    # ─── Genie CLI Install/Update ───
    header "Installing Genie CLI..."
    install_genie_cli

    # ─── Locate package directory ───
    if ! locate_package_dir; then
        error "Could not locate Genie package directory"
        exit 1
    fi
    log "Package directory: $PKG_DIR"

    # ─── Plugin Integrations ───
    if $INTERACTIVE; then
        header "Plugin Integrations"
        echo -e "${DIM}────────────────────────────────────${NC}"

        offer_claude_plugin
        echo

        offer_openclaw_plugin
        echo

        offer_codex_skills

        print_success
    else
        output_agent_prompt
    fi
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

    # Try claude plugin uninstall for marketplace-installed plugins
    if check_command claude && claude plugin list 2>/dev/null | grep -q "genie"; then
        if confirm "Unregister Claude Code plugin from marketplace?"; then
            claude plugin uninstall genie@namastexlabs 2>/dev/null || true
            success "Claude Code plugin unregistered"
            removed_something=true
        else
            info "Keeping Claude Code plugin registration"
        fi
    fi

    # 3. OpenClaw plugin (default: yes)
    if check_command openclaw && openclaw plugins list 2>/dev/null | grep -q "genie"; then
        if confirm "Remove OpenClaw plugin?"; then
            local ext_dir="$HOME/.openclaw/extensions/genie"

            # Best effort: disable in config first (if present)
            openclaw plugins disable genie 2>/dev/null || true

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

    # 4. Codex/OpenCode skills (default: yes)
    local codex_link="$CODEX_SKILLS_DIR/genie"
    if [[ -e "$codex_link" || -L "$codex_link" ]]; then
        if confirm "Remove Codex/OpenCode skills?"; then
            rm -f "$codex_link"
            success "Codex skills removed"
            removed_something=true
        else
            info "Keeping Codex skills"
        fi
    fi

    # 5. Config directory (default: no - preserve settings)
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
