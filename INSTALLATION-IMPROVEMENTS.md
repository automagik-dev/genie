# Installation Script Improvements

## 🎯 Problem Statement

The original `start.sh` script was failing with 429 errors and lacked comprehensive dependency management. Mac users were experiencing issues with missing Homebrew, and the script didn't verify or install essential tools like git and GitHub CLI.

## 🏗️ Refactoring: From Good to Squeaky Clean

**Version 1:** Comprehensive dependency management (377 lines)
**Version 2:** Helper function refactor - production-grade maintainability (524 lines)

### Code Organization Improvements

**Before (inline logic):**
```bash
# Repeated pattern in each section
if ! command -v git &> /dev/null; then
    if [ "$OS_TYPE" = "macos" ]; then
        brew install git
    elif [ "$OS_TYPE" = "linux" ]; then
        if [ "$DISTRO" = "ubuntu" ]; then
            apt-get install git
        elif [ "$DISTRO" = "fedora" ]; then
            dnf install git
        ...
    fi
fi
```

**After (helper functions):**
```bash
# OS-specific helpers at top
install_macos() { brew install "$1"; }
install_ubuntu() { sudo apt-get update && sudo apt-get install -y "$1"; }
install_fedora() { sudo dnf install -y "$1" || sudo yum install -y "$1"; }
install_arch() { sudo pacman -S --noconfirm "$1"; }

# Generic installer with perfect OS separation
install_package() {
    case "$OS_TYPE" in
        macos) install_macos "$1" ;;
        linux)
            case "$DISTRO" in
                ubuntu|debian) install_ubuntu "$1" ;;
                fedora|rhel)   install_fedora "$1" ;;
                arch)          install_arch "$1" ;;
            esac ;;
    esac
}

# Clean install function
install_git() {
    command_exists git && { show_installed; return 0; }
    install_package git || { show_error; exit 1; }
    show_success
}
```

### Maintainability Benefits

1. **Single Responsibility** - Each function does one thing
2. **DRY Principle** - No code duplication across tools
3. **OS Separation** - Platform logic isolated in helper functions
4. **Easy Extension** - Add new Linux distro? One line in helper
5. **Clear Flow** - Main section is 7 function calls (self-documenting)

### Main Installation Flow (Crystal Clear)

```bash
# Execute installation steps in order
install_homebrew
install_git
install_github_cli
authenticate_github
install_nodejs
install_pnpm
install_genie
show_summary
```

**Any developer can understand this at a glance!**

## ✨ What's New

### 1. **Operating System Detection**
- Automatically detects macOS, Linux (Ubuntu, Debian, Fedora, RHEL, CentOS, Arch), Windows/WSL
- Platform-specific installation strategies for maximum compatibility

### 2. **Homebrew Auto-Installation (macOS)**
- Detects if Homebrew is installed
- If missing, automatically installs Homebrew
- Handles both Apple Silicon (arm64) and Intel architectures
- Adds Homebrew to PATH automatically

### 3. **Git Installation**
- Verifies git is installed
- If missing, installs via platform-specific package manager:
  - macOS: Homebrew
  - Ubuntu/Debian: `apt-get`
  - Fedora/RHEL/CentOS: `dnf`/`yum`
  - Arch: `pacman`

### 4. **GitHub CLI (gh) Installation**
- Verifies GitHub CLI is installed
- If missing, installs via official methods for each platform
- Critical for issue tracking, PR creation, and repo management

### 5. **GitHub CLI Authentication**
- Checks if already authenticated
- If not, prompts user to authenticate via browser (OAuth)
- Skippable (user can authenticate later with `gh auth login`)
- Shows authenticated username on success

### 6. **Node.js Installation**
- macOS: Uses Homebrew (system-wide, clean)
- Linux/Unix: Uses nvm (user-local, no sudo)
- Installs Node.js 22 (LTS)

### 7. **pnpm Installation**
- macOS: Uses Homebrew
- Linux/Unix: Uses npm with user prefix (no sudo)
- Automatic PATH configuration

### 8. **Colored Output & Better UX**
- Color-coded status messages (green for success, yellow for warnings, cyan for info)
- Clear progress indicators
- Final installation summary showing all installed dependencies

### 9. **Comprehensive Error Handling**
- Graceful fallback for unknown distributions
- Clear error messages with actionable instructions
- Non-blocking authentication (can skip and do later)

## 🧪 Testing

### Quick Syntax Test
```bash
bash -n start.sh
```

### Test on Fresh VM (Ubuntu)
```bash
# Clean environment
docker run -it ubuntu:latest bash

# Install curl first
apt-get update && apt-get install -y curl

# Run Genie installer
bash -c "$(curl -fsSL https://install.namastex.ai/start.sh)"
```

### Test on macOS
```bash
# Fresh macOS (no Homebrew)
bash -c "$(curl -fsSL https://install.namastex.ai/start.sh)"
```

## 📋 Installation Flow

The new installation script follows this sequence:

1. **OS Detection** → Identifies your operating system
2. **Homebrew** (macOS only) → Installs if missing
3. **Git** → Verifies/installs version control
4. **GitHub CLI** → Verifies/installs for GitHub integration
5. **GitHub Auth** → Prompts for authentication (skippable)
6. **Node.js** → Installs JavaScript runtime
7. **pnpm** → Installs fast package manager
8. **Genie** → Installs/updates Genie CLI
9. **Summary** → Shows all installed dependencies
10. **Launch** → Starts Genie automatically

## 🎨 User Experience

**Before:**
```
Error: 429 rate limit exceeded
Missing dependency: git not found
Missing dependency: gh not found
```

**After:**
```
🧞 ✨ THE MASTER GENIE AWAKENS ✨

🍎 Detected: macOS
✅ Homebrew already installed
✅ Git already installed (v2.39.2)
📦 Installing GitHub CLI (gh)...
✅ GitHub CLI installed successfully!
🔑 GitHub CLI authenticated as @namastex
✅ Node.js already installed (v22.0.0)
✅ pnpm already installed (v9.1.0)
✅ Genie is ready to grant your wishes! ✨

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✨ INSTALLATION COMPLETE ✨
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📦 Installed dependencies:
  ✓ git (v2.39.2)
  ✓ GitHub CLI (v2.40.0)
  ✓ Node.js (v22.0.0)
  ✓ pnpm (v9.1.0)
  ✓ Genie (2.5.0-rc.92)

🧞 Your wish is my command...
```

## 🚀 Quick Start (One Command)

### Linux/macOS
```bash
bash -c "$(curl -fsSL https://install.namastex.ai/start.sh)"
```

### Windows (PowerShell)
```powershell
irm https://install.namastex.ai/start.ps1 -OutFile "$env:TEMP\genie-install.ps1"; & "$env:TEMP\genie-install.ps1"
```

## 🔒 Security & Privacy

- All installations are user-local (no sudo required for most operations)
- GitHub authentication uses OAuth (secure, browser-based)
- No credentials stored in plain text
- All data stays on your machine

## 📝 Dependencies Installed

| Tool | Purpose | Installation Method |
|------|---------|-------------------|
| **Homebrew** | Package manager (macOS) | Official install script |
| **git** | Version control | Homebrew / apt / dnf / pacman |
| **gh** | GitHub CLI | Homebrew / official repos |
| **Node.js** | JavaScript runtime | Homebrew / nvm |
| **pnpm** | Fast package manager | Homebrew / npm |
| **Genie** | AI agent framework | pnpm global install |

## 🎯 Success Metrics

- ✅ **Zero manual dependency installation** for non-technical users
- ✅ **Cross-platform support** (macOS, Ubuntu, Debian, Fedora, Arch, Windows/WSL)
- ✅ **Automatic GitHub authentication** (with skip option)
- ✅ **Clear, colored progress indicators**
- ✅ **Comprehensive error handling**
- ✅ **No sudo required** (except for system package managers on Linux)

## 🐛 Known Limitations

- On Linux, system package installation (git, gh) requires sudo
- GitHub authentication requires browser access (can be skipped)
- Some Linux distributions may not be automatically detected (fallback to generic Unix)

## 📞 Support

If you encounter issues:

1. Check the error message (now much clearer!)
2. Ensure you have internet access
3. For manual installation: Visit individual tool documentation
4. File an issue: https://github.com/namastexlabs/automagik-genie/issues

## 🎉 Next Steps

After successful installation, Genie will:
1. Run `genie init` to set up your workspace
2. Start the Install agent (Forge-backed)
3. Guide you through configuration
4. Begin granting your wishes! ✨
