# Genie Smart Run Script for Windows
# Detects context and guides user through appropriate workflow

Write-Host "🧞 Genie Smart Run" -ForegroundColor Cyan
Write-Host "==================" -ForegroundColor Cyan
Write-Host ""

# Case 1: Check if .genie folder exists
if (Test-Path ".genie") {
    Write-Host "✅ Found .genie workspace in current directory" -ForegroundColor Green
    Write-Host ""

    # Check if Genie/Forge is already running on port 8887
    $connection = Get-NetTCPConnection -LocalPort 8887 -State Listen -ErrorAction SilentlyContinue
    if ($connection) {
        $PID = $connection.OwningProcess
        Write-Host "⚠️  Genie server already running (PID: $PID, Port: 8887)" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Options:"
        Write-Host "  1. Connect to existing server (recommended)"
        Write-Host "  2. Stop and restart"
        Write-Host ""
        $choice = Read-Host "Choice [1]"
        if ([string]::IsNullOrEmpty($choice)) { $choice = "1" }

        if ($choice -eq "2") {
            Write-Host "Stopping existing server..." -ForegroundColor Yellow
            Stop-Process -Id $PID -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        } else {
            Write-Host "Using existing server at http://localhost:8887" -ForegroundColor Green
            Write-Host ""
            Write-Host "💡 MCP already available!" -ForegroundColor Yellow
            Write-Host "   Configure Claude Code: npx automagik-genie mcp -t stdio" -ForegroundColor White
            exit 0
        }
    }

    # Check if genie is installed globally
    if (Get-Command genie -ErrorAction SilentlyContinue) {
        Write-Host "Using globally installed genie..." -ForegroundColor White
        genie
    } else {
        Write-Host "Running via pnpm dlx..." -ForegroundColor White
        pnpm dlx automagik-genie@next
    }
} else {
    # Case 2: No .genie folder - fresh user
    Write-Host "📂 No .genie workspace found" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "💡 To use Genie in this directory:" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "   Option 1: Install globally (recommended)" -ForegroundColor White
    Write-Host "   $ pnpm install -g automagik-genie@next" -ForegroundColor Gray
    Write-Host "   $ genie init" -ForegroundColor Gray
    Write-Host ""
    Write-Host "   Option 2: Quick test without install" -ForegroundColor White
    Write-Host "   $ pnpm dlx automagik-genie@next init" -ForegroundColor Gray
    Write-Host ""
    $install = Read-Host "Install Genie globally? [y/N]"

    if ($install -match "^[Yy]$") {
        Write-Host ""
        Write-Host "Installing Genie globally..." -ForegroundColor Cyan
        pnpm install -g automagik-genie@next
        Write-Host ""
        Write-Host "✅ Genie installed!" -ForegroundColor Green
        Write-Host ""
        $init = Read-Host "Initialize .genie workspace in current directory? [Y/n]"
        if ([string]::IsNullOrEmpty($init)) { $init = "Y" }

        if ($init -match "^[Yy]$") {
            Write-Host ""
            genie init
        } else {
            Write-Host ""
            Write-Host "💡 Run 'genie init' when ready to set up this project" -ForegroundColor Yellow
        }
    } else {
        Write-Host ""
        Write-Host "Running quick test via pnpm dlx..." -ForegroundColor White
        pnpm dlx automagik-genie@next init
    }
}

# Offer permanent installation reminder
if (-not (Get-Command genie -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "💡 Want to install Genie permanently?" -ForegroundColor Yellow
    Write-Host "   Run: pnpm install -g automagik-genie@next" -ForegroundColor White
    Write-Host ""
    Write-Host "   Then use 'genie' command from anywhere!" -ForegroundColor White
    Write-Host ""
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
}
