# Genie Windows Installer - Permission-Free Installation
# Installs Node.js, pnpm, and Genie without requiring Administrator privileges

Write-Host "🧞 Genie Installer for Windows" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan
Write-Host ""

# 1. Check if Node.js exists
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Node.js not found" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Node.js 18+ first:" -ForegroundColor Yellow
    Write-Host "  https://nodejs.org/en/download/" -ForegroundColor White
    Write-Host ""
    Write-Host "Or use nvm-windows:" -ForegroundColor Yellow
    Write-Host "  https://github.com/coreybutler/nvm-windows" -ForegroundColor White
    Write-Host ""
    exit 1
}

$nodeVersion = node -v
Write-Host "✅ Node.js found: $nodeVersion" -ForegroundColor Green

# 2. Ensure pnpm exists (permission-free installation)
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "Installing pnpm..." -ForegroundColor Yellow

    # Try corepack first (built into Node.js 16.9+, no permissions needed)
    if (Get-Command corepack -ErrorAction SilentlyContinue) {
        Write-Host "Using corepack (built-in Node.js package manager)..." -ForegroundColor White
        corepack enable
        corepack prepare pnpm@latest --activate
    } else {
        # Fallback: Install to user AppData (no admin required)
        Write-Host "Installing pnpm to user directory..." -ForegroundColor White
        $env:PNPM_HOME = "$env:LOCALAPPDATA\pnpm"
        $env:Path = "$env:PNPM_HOME;$env:Path"

        # Create pnpm directory if it doesn't exist
        if (-not (Test-Path $env:PNPM_HOME)) {
            New-Item -ItemType Directory -Path $env:PNPM_HOME -Force | Out-Null
        }

        # Install pnpm using npm (to user directory)
        npm install -g pnpm --prefix="$env:PNPM_HOME"

        # Add to PATH permanently for current user
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if ($userPath -notlike "*$env:PNPM_HOME*") {
            [Environment]::SetEnvironmentVariable("Path", "$env:PNPM_HOME;$userPath", "User")
            Write-Host "✅ Added pnpm to user PATH" -ForegroundColor Green
        }
    }
}

# Verify pnpm installation
if (Get-Command pnpm -ErrorAction SilentlyContinue) {
    $pnpmVersion = pnpm -v
    Write-Host "✅ pnpm found: v$pnpmVersion" -ForegroundColor Green
} else {
    Write-Host "❌ pnpm installation failed" -ForegroundColor Red
    Write-Host "Please restart your terminal and try again" -ForegroundColor Yellow
    exit 1
}

Write-Host ""

# 3. Check for updates and run Genie
if (Get-Command genie -ErrorAction SilentlyContinue) {
    # Get installed version
    $installedVersion = (genie --version 2>$null) -replace '.*?(\d+\.\d+\.\d+(-rc\.\d+)?).*', '$1'
    if ([string]::IsNullOrEmpty($installedVersion)) { $installedVersion = "0.0.0" }

    # Get latest @next version from npm
    $latestVersion = (npm view automagik-genie@next version 2>$null)
    if ([string]::IsNullOrEmpty($latestVersion)) { $latestVersion = $installedVersion }

    # Compare versions
    if ($installedVersion -ne $latestVersion) {
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
        Write-Host "🧞 ✨ UPDATE AVAILABLE" -ForegroundColor Cyan
        Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "Installed: $installedVersion" -ForegroundColor White
        Write-Host "Latest:    $latestVersion" -ForegroundColor White
        Write-Host ""
        Write-Host "Updating Genie..." -ForegroundColor Yellow
        pnpm install -g automagik-genie@next
        Write-Host ""
        Write-Host "✅ Updated to $latestVersion" -ForegroundColor Green
        Write-Host ""
    }
    genie $args
} else {
    # Not installed - use dlx (auto-downloads latest)
    Write-Host "Running Genie via pnpm dlx..." -ForegroundColor White
    pnpm dlx automagik-genie@next $args
}
