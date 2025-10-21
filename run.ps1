# Genie Quick Run Script for Windows
# Run Genie without installing (uses pnpm dlx)

Write-Host "🧞 Genie Quick Run" -ForegroundColor Cyan
Write-Host "==================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Running Genie via pnpm dlx (no installation)..." -ForegroundColor White
Write-Host ""

# Run Genie using pnpm dlx (no install)
pnpm dlx automagik-genie@next
