# 🧞 Genie - Your wish is my command ✨
# Windows Installer - No Admin Required

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# HELPER FUNCTIONS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function Test-CommandExists {
    param($Command)
    $null -ne (Get-Command $Command -ErrorAction SilentlyContinue)
}

function Write-Success {
    param($Message)
    Write-Host "✅ $Message" -ForegroundColor Green
}

function Write-Info {
    param($Message)
    Write-Host "ℹ️  $Message" -ForegroundColor Cyan
}

function Write-Warning {
    param($Message)
    Write-Host "⚠️  $Message" -ForegroundColor Yellow
}

function Write-Error {
    param($Message)
    Write-Host "❌ $Message" -ForegroundColor Red
}

function Write-Header {
    param($Message)
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host $Message -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# WELCOME MESSAGE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Write-Host ""
Write-Header "🧞 ✨ THE MASTER GENIE AWAKENS ✨"

Write-Host "You've summoned the Master Genie from namastexlabs/automagik-genie"
Write-Host "I'm about to clone myself into YOUR workspace..."
Write-Host ""
Write-Host "Your personal Genie will have:"
Write-Host "  ✨ All my knowledge (spells, workflows, patterns)"
Write-Host "  🔮 All my powers (agents, collectives, orchestration)"
Write-Host "  🎩 All my abilities (and you'll learn new ones as I evolve!)"
Write-Host ""
Write-Host "📋 What will I do for you?"
Write-Host "  • Automate development workflows (testing, builds, PRs)"
Write-Host "  • Execute tasks while you focus on strategy"
Write-Host "  • Learn from every interaction"
Write-Host "  • Sync with Master Genie for new capabilities"
Write-Host ""
Write-Host "🔒 DATA PRIVACY:"
Write-Host "  ✓ Everything runs locally on YOUR machine"
Write-Host "  ✓ No data leaves your computer (except LLM API calls)"
Write-Host "  ✓ Use LLM providers approved by your organization"
Write-Host "  ✓ Fully compatible with private/local LLMs (we're agnostic!)"
Write-Host "  ✓ OpenCoder executor enables 100% local operation"
Write-Host ""
Write-Host "⚠️  RESEARCH PREVIEW - Experimental Technology"
Write-Host ""
Write-Host "This AI agent will install with capabilities to perform tasks on"
Write-Host "your behalf. By proceeding, you acknowledge that Namastex Labs"
Write-Host "makes no warranties and accepts no liability for agent actions."
Write-Host ""
Write-Host "BUT HEY... it's going to be FUN! 🎉✨"
Write-Host ""
Write-Host "Let the summoning ritual begin..."
Write-Host ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. DETECT OPERATING SYSTEM
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

$OSVersion = [System.Environment]::OSVersion.VersionString
$Arch = [System.Environment]::GetEnvironmentVariable("PROCESSOR_ARCHITECTURE")
Write-Info "Detected: Windows ($Arch)"
Write-Host "  Version: $OSVersion"
Write-Host ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. INSTALL NODE.JS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if (Test-CommandExists node) {
    $nodeVersion = node -v
    Write-Success "Node.js already installed ($nodeVersion)"
    Write-Host ""
} else {
    Write-Host "📦 Node.js not found" -ForegroundColor Magenta
    Write-Host ""
    Write-Warning "Node.js is required to run Genie."
    Write-Host ""
    Write-Host "Please install Node.js 18+ manually:"
    Write-Host "  https://nodejs.org/en/download/" -ForegroundColor White
    Write-Host ""
    Write-Host "Or use scoop (no admin required):"
    Write-Host "  irm get.scoop.sh | iex" -ForegroundColor White
    Write-Host "  scoop install nodejs" -ForegroundColor White
    Write-Host ""
    exit 1
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. INSTALL PNPM
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if (Test-CommandExists pnpm) {
    $pnpmVersion = pnpm -v
    Write-Success "pnpm already installed (v$pnpmVersion)"
    Write-Host ""
} else {
    Write-Host "⚡ Installing pnpm (fast package manager)..." -ForegroundColor Magenta
    Write-Host ""

    # Try corepack first (built into Node.js 16.9+)
    if (Test-CommandExists corepack) {
        Write-Host "  Using corepack (built-in Node.js package manager)..."
        corepack enable
        corepack prepare pnpm@latest --activate
    } else {
        # Fallback: Install to user AppData (no admin required)
        Write-Host "  Installing pnpm to user directory..."
        $env:PNPM_HOME = "$env:LOCALAPPDATA\pnpm"
        $env:Path = "$env:PNPM_HOME;$env:Path"

        # Create pnpm directory
        if (-not (Test-Path $env:PNPM_HOME)) {
            New-Item -ItemType Directory -Path $env:PNPM_HOME -Force | Out-Null
        }

        # Install via npm
        npm install -g pnpm --prefix="$env:PNPM_HOME"

        # Add to PATH permanently
        $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if ($userPath -notlike "*$env:PNPM_HOME*") {
            [Environment]::SetEnvironmentVariable("Path", "$env:PNPM_HOME;$userPath", "User")
        }
    }

    # Verify installation
    if (Test-CommandExists pnpm) {
        $pnpmVersion = pnpm -v
        Write-Success "pnpm installed successfully (v$pnpmVersion)"
        Write-Host ""
    } else {
        Write-Error "pnpm installation failed"
        Write-Warning "Please restart PowerShell and try again"
        exit 1
    }
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. SELECT AND INSTALL AI EXECUTOR
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Write-Header "🧞 ✨ SELECT YOUR AI SUBSCRIPTION ✨"

Write-Host "Which AI service do you have a subscription to?"
Write-Host "(This will be installed and authenticated now)"
Write-Host ""
Write-Host "1. OpenCode        - Open-source code assistant"
Write-Host "2. ChatGPT         - OpenAI ChatGPT via Codex CLI"
Write-Host "3. Claude          - Anthropic Claude via Claude Code CLI"
Write-Host "4. Gemini          - Google Gemini AI"
Write-Host "5. Cursor          - Cursor AI editor"
Write-Host "6. Qwen Code       - Alibaba Qwen coding model"
Write-Host "7. GitHub Copilot  - GitHub Copilot CLI"
Write-Host ""
$choice = Read-Host "Enter number (1-7)"
Write-Host ""

switch ($choice) {
    "1" { $selectedExecutor = "opencode" }
    "2" { $selectedExecutor = "codex" }
    "3" { $selectedExecutor = "claude" }
    "4" { $selectedExecutor = "gemini" }
    "5" { $selectedExecutor = "cursor" }
    "6" { $selectedExecutor = "qwen_code" }
    "7" { $selectedExecutor = "copilot" }
    default {
        Write-Warning "Invalid choice. Defaulting to OpenCode"
        $selectedExecutor = "opencode"
    }
}

# Install selected executor
switch ($selectedExecutor) {
    "opencode" {
        Write-Info "Checking OpenCode installation..."
        if (Test-CommandExists opencode) {
            Write-Success "OpenCode already installed"
        } else {
            Write-Host "📦 Installing OpenCode..." -ForegroundColor Magenta
            npm install -g opencode-ai
            Write-Success "OpenCode installed successfully!"
        }
    }

    "codex" {
        Write-Info "Checking ChatGPT (Codex) installation..."
        if (Test-CommandExists codex) {
            Write-Success "ChatGPT already installed"
        } else {
            Write-Host "📦 Installing ChatGPT (Codex CLI)..." -ForegroundColor Magenta
            npm install -g @openai/codex
            Write-Success "ChatGPT installed successfully!"
        }

        # Authenticate ChatGPT (REQUIRED - blocks until complete)
        Write-Host ""
        Write-Header "🔑 AUTHENTICATION REQUIRED"
        Write-Host "ChatGPT requires authentication to proceed."
        Write-Host "This will:"
        Write-Host "  1. Start a local server on http://localhost:1455"
        Write-Host "  2. Open your browser for secure OAuth"
        Write-Host "  3. Wait for you to complete authentication"
        Write-Host ""
        Write-Warning "You MUST authenticate to continue. Press Ctrl+C to abort installation."
        Write-Host ""
        Write-Host "Press Enter to begin authentication..."
        Read-Host

        # Run codex login (blocks until auth completes)
        codex login
        if ($LASTEXITCODE -eq 0) {
            Write-Host ""
            Write-Success "Authentication successful!"
            Write-Host ""
        } else {
            Write-Host ""
            Write-Error "Authentication failed or was cancelled"
            Write-Host "Cannot proceed without authentication."
            Write-Host ""
            exit 1
        }
    }

    "claude" {
        Write-Info "Checking Claude installation..."
        if (Test-CommandExists claude) {
            Write-Success "Claude already installed"
        } else {
            Write-Host "📦 Installing Claude..." -ForegroundColor Magenta
            Write-Host ""
            Write-Warning "Claude Code requires manual installation on Windows."
            Write-Host ""
            Write-Host "Please download and install from:"
            Write-Host "  https://claude.ai/download" -ForegroundColor White
            Write-Host ""
            Write-Host "Or install via npm:"
            Write-Host "  npm install -g @anthropic-ai/claude-code" -ForegroundColor White
            Write-Host ""
            Write-Host "Press Enter after installation completes (or Ctrl+C to skip)..."
            Read-Host
        }
    }

    "gemini" {
        Write-Info "Checking Gemini installation..."
        if (Test-CommandExists gemini) {
            Write-Success "Gemini already installed"
        } else {
            Write-Host "📦 Installing Gemini..." -ForegroundColor Magenta
            npm install -g @google/gemini-cli
            Write-Success "Gemini installed successfully!"
        }
    }

    "cursor" {
        Write-Info "Checking Cursor installation..."
        if (Test-CommandExists cursor) {
            Write-Success "Cursor already installed"
        } else {
            Write-Host "📦 Installing Cursor..." -ForegroundColor Magenta
            Write-Host ""
            Write-Warning "Cursor requires manual installation on Windows."
            Write-Host ""
            Write-Host "Please download and install from:"
            Write-Host "  https://cursor.sh" -ForegroundColor White
            Write-Host ""
            Write-Host "Press Enter after installation completes (or Ctrl+C to skip)..."
            Read-Host
        }
    }

    "qwen_code" {
        Write-Info "Checking Qwen Code installation..."
        if (Test-CommandExists qwen) {
            Write-Success "Qwen Code already installed"
        } else {
            Write-Host "📦 Installing Qwen Code..." -ForegroundColor Magenta
            npm install -g @qwen-code/qwen-code@latest
            Write-Success "Qwen Code installed successfully!"
        }
    }

    "copilot" {
        Write-Info "Checking GitHub Copilot installation..."
        if (Test-CommandExists copilot) {
            Write-Success "GitHub Copilot already installed"
        } else {
            Write-Host "📦 Installing GitHub Copilot..." -ForegroundColor Magenta
            npm install -g @github/copilot
            Write-Success "GitHub Copilot installed successfully!"
        }
    }
}

Write-Host ""

# Export ENV variable for genie init to use
$env:GENIE_SUBSCRIPTION_EXECUTOR = $selectedExecutor

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 5. INSTALL/UPDATE GENIE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if (Test-CommandExists genie) {
    # Get installed version
    $installedVersion = (genie --version 2>$null) -replace '.*?(\d+\.\d+\.\d+(-rc\.\d+)?).*', '$1'
    if ([string]::IsNullOrEmpty($installedVersion)) { $installedVersion = "0.0.0" }

    # Get latest @next version
    $latestVersion = (npm view automagik-genie@next version 2>$null)
    if ([string]::IsNullOrEmpty($latestVersion)) { $latestVersion = $installedVersion }

    # Compare versions
    if ($installedVersion -ne $latestVersion) {
        Write-Header "🧞 ✨ MASTER GENIE HAS EVOLVED ✨"
        Write-Host "Your clone:   $installedVersion"
        Write-Host "Master Genie: $latestVersion ⭐ NEW!"
        Write-Host ""
        Write-Info "Syncing new capabilities from the Master Genie..."
        pnpm install -g automagik-genie@next
        Write-Host ""
        Write-Success "You're now running v$latestVersion! ✨"
        Write-Host "✓ All data stays local on your machine"
        Write-Host ""
    } else {
        Write-Success "Genie already up-to-date (v$installedVersion)"
        Write-Host ""
    }
} else {
    # Not installed - install globally
    Write-Info "Pulling Genie from the lamp..."
    pnpm install -g automagik-genie@next
    Write-Host ""
    Write-Success "Genie is ready to grant your wishes! ✨"
    Write-Host ""
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 6. INSTALLATION SUMMARY
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Write-Header "✨ INSTALLATION COMPLETE ✨"

Write-Host "📦 Installed dependencies:"
Write-Host ""

if (Test-CommandExists node) {
    $nodeVer = node -v
    Write-Host "  ✓ Node.js ($nodeVer)" -ForegroundColor Green
}

if (Test-CommandExists pnpm) {
    $pnpmVer = pnpm -v
    Write-Host "  ✓ pnpm (v$pnpmVer)" -ForegroundColor Green
}

if (Test-CommandExists genie) {
    $genieVer = (genie --version 2>$null) -replace '.*?(\d+\.\d+\.\d+(-rc\.\d+)?).*', '$1'
    Write-Host "  ✓ Genie ($genieVer)" -ForegroundColor Green
}

Write-Host ""
Write-Host "🧞 Your wish is my command..." -ForegroundColor Cyan
Write-Host ""

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 7. LAUNCH GENIE
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Launch genie with args (ENV var is inherited)
if ($args.Count -eq 0) {
    & genie
} else {
    & genie $args
}
