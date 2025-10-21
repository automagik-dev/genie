# Genie Installation Script for Windows
# This script installs npm, pnpm, and runs Genie
# IMPORTANT: Run PowerShell as Administrator for this script to work

# Enable strict mode
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "🧞 Genie Installation Script for Windows" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Check if running as Administrator
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Host "⚠ WARNING: This script requires Administrator privileges" -ForegroundColor Yellow
    Write-Host "Please close this window and:" -ForegroundColor Yellow
    Write-Host "1. Right-click PowerShell" -ForegroundColor Yellow
    Write-Host "2. Select 'Run as Administrator'" -ForegroundColor Yellow
    Write-Host "3. Run this script again" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "Press any key to exit..." -ForegroundColor Yellow
    $null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
    exit 1
}

# Function to print colored output
function Print-Success {
    param([string]$Message)
    Write-Host "✓ $Message" -ForegroundColor Green
}

function Print-Warning {
    param([string]$Message)
    Write-Host "⚠ $Message" -ForegroundColor Yellow
}

function Print-Error {
    param([string]$Message)
    Write-Host "✗ $Message" -ForegroundColor Red
}

# Step 1: Check if npm is installed
Write-Host "Step 1: Checking for npm..." -ForegroundColor White
try {
    $npmVersion = npm -v 2>$null
    if ($LASTEXITCODE -eq 0) {
        Print-Success "npm is already installed (version $npmVersion)"
    }
} catch {
    Print-Warning "npm not found. Installing Node.js via Chocolatey..."

    # Check if Chocolatey is installed
    try {
        $chocoVersion = choco -v 2>$null
        if ($LASTEXITCODE -eq 0) {
            Print-Success "Chocolatey is already installed"
        }
    } catch {
        Print-Warning "Chocolatey not found. Installing Chocolatey..."

        # Set execution policy for this process
        Set-ExecutionPolicy Bypass -Scope Process -Force

        # Install Chocolatey
        [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
        Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))

        Print-Success "Chocolatey installed"

        # Refresh environment variables
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
    }

    # Install Node.js via Chocolatey
    Write-Host "Installing Node.js 22.21.0..." -ForegroundColor White
    choco install nodejs --version="22.21.0" -y

    # Refresh environment variables
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

    # Verify installation
    $nodeVersion = node -v
    $npmVersion = npm -v
    Print-Success "Node.js installed: $nodeVersion"
    Print-Success "npm installed: $npmVersion"
}

Write-Host ""

# Step 2: Check if pnpm is installed
Write-Host "Step 2: Checking for pnpm..." -ForegroundColor White
try {
    $pnpmVersion = pnpm -v 2>$null
    if ($LASTEXITCODE -eq 0) {
        Print-Success "pnpm is already installed (version $pnpmVersion)"
    }
} catch {
    Print-Warning "pnpm not found. Installing pnpm..."
    npm install -g pnpm

    # Refresh environment variables
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

    $pnpmVersion = pnpm -v
    Print-Success "pnpm installed (version $pnpmVersion)"
}

Write-Host ""

# Step 3: Run Genie
Write-Host "Step 3: Launching Genie..." -ForegroundColor White
Print-Success "Running: pnpm dlx automagik-genie@latest"
Write-Host ""

pnpm dlx automagik-genie@latest
