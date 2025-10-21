# 🧞 Genie Installation Guide

This guide provides automated installation scripts for Linux, macOS, and Windows.

## Quick Start

### Linux / macOS

```bash
# Download and run the installation script
curl -fsSL https://raw.githubusercontent.com/namastex/automagik-genie/main/install.sh | bash
```

Or if you've already cloned the repository:

```bash
# Make the script executable (if not already)
chmod +x install.sh

# Run the installer
./install.sh
```

### Windows

**Option 1: Using the Batch File (Recommended)**

1. Right-click `install.bat`
2. Select "Run as administrator"
3. Follow the prompts

**Option 2: Using PowerShell Directly**

1. Right-click PowerShell
2. Select "Run as administrator"
3. Run the following command:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\install.ps1
```

**Option 3: Download and Run**

```powershell
# Download and run the installation script
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/namastex/automagik-genie/main/install.ps1" -OutFile "$env:TEMP\genie-install.ps1"
powershell.exe -ExecutionPolicy Bypass -File "$env:TEMP\genie-install.ps1"
```

---

## What the Installers Do

The installation scripts perform the following steps:

### Step 1: Verify/Install npm

**Linux/macOS:**
- Checks if npm is installed
- If not found, installs [nvm](https://github.com/nvm-sh/nvm) (Node Version Manager)
- Installs Node.js version 22 via nvm
- Verifies Node.js and npm installation

**Windows:**
- Checks if npm is installed
- If not found, checks for [Chocolatey](https://chocolatey.org/)
- Installs Chocolatey if needed (requires Administrator privileges)
- Installs Node.js 22.21.0 via Chocolatey
- Verifies Node.js and npm installation

### Step 2: Verify/Install pnpm

- Checks if [pnpm](https://pnpm.io/) is installed
- If not found, installs pnpm globally via npm

### Step 3: Launch Genie

- Runs `pnpm dlx automagik-genie@latest` to execute Genie

---

## Manual Installation

If you prefer to install manually or the automated scripts don't work for your environment:

### 1. Install Node.js and npm

**Linux/macOS:**

```bash
# Download and install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash

# Load nvm (or restart your terminal)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Install Node.js 22
nvm install 22

# Verify installation
node -v  # Should print "v22.x.x"
npm -v   # Should print "10.x.x"
```

**Windows:**

```powershell
# Install Chocolatey (run PowerShell as Administrator)
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

# Install Node.js
choco install nodejs --version="22.21.0" -y

# Verify installation
node -v  # Should print "v22.21.0"
npm -v   # Should print "10.9.4"
```

### 2. Install pnpm

```bash
npm install -g pnpm
```

### 3. Run Genie

```bash
pnpm dlx automagik-genie@latest
```

---

## Troubleshooting

### Windows: "Execution Policy" Error

If you see an error about execution policies, run PowerShell as Administrator and execute:

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Windows: "Administrator Privileges Required"

The Windows installer requires Administrator privileges to install Chocolatey and Node.js. Make sure to:

1. Right-click PowerShell
2. Select "Run as administrator"
3. Run the installation script again

### Linux/macOS: Permission Denied

If you get a "permission denied" error, make sure the script is executable:

```bash
chmod +x install.sh
```

### nvm Command Not Found (Linux/macOS)

If `nvm` is not found after installation, you may need to restart your terminal or manually load nvm:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
```

Consider adding these lines to your `~/.bashrc`, `~/.zshrc`, or equivalent shell configuration file.

### Chocolatey Installation Fails (Windows)

Ensure you're running PowerShell as Administrator and your internet connection is stable. If issues persist, manually install Chocolatey following the official guide at https://chocolatey.org/install

---

## Version Requirements

- **Node.js:** v22.x (recommended: v22.21.0)
- **npm:** v10.x (comes with Node.js)
- **pnpm:** Latest version (installed automatically)

---

## Support

For issues or questions:
- GitHub Issues: https://github.com/namastex/automagik-genie/issues
- Documentation: https://github.com/namastex/automagik-genie

---

## License

See [LICENSE](LICENSE) file for details.
