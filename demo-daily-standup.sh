#!/bin/bash

# Demo: Genie Daily Standup - Three Execution Modes
# Created for team video tutorial by Felipe Rosa

set -e

echo "========================================="
echo "🧞 Genie Daily Standup - Demo Script"
echo "========================================="
echo ""
echo "This demo shows 3 ways to use Genie agents:"
echo "1. Browser Mode (interactive UI)"
echo "2. Headless Mode (background task)"
echo "3. Crontab Mode (scheduled automation)"
echo ""

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ========================================
# Example 1: Browser Mode (Interactive)
# ========================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📱 Example 1: Browser Mode (Interactive)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}Use Case:${NC} When you want to SEE the agent working in real-time"
echo -e "${GREEN}Command:${NC}"
echo ""
echo "  genie run code/explore \"Review authentication implementation\""
echo ""
echo -e "${YELLOW}What happens:${NC}"
echo "  ✓ Opens browser in fullscreen"
echo "  ✓ Shows live progress in Forge UI"
echo "  ✓ You can watch the agent think and work"
echo "  ✓ Returns JSON results when done"
echo ""
read -p "Press Enter to see the actual command (won't execute)..."
echo ""
echo -e "${GREEN}$ genie run code/explore \"Review authentication implementation\"${NC}"
echo ""

# ========================================
# Example 2: Headless Mode (Background)
# ========================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}🎯 Example 2: Headless Mode (Background)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}Use Case:${NC} When you want the task to run in background"
echo -e "${GREEN}Command:${NC}"
echo ""
echo "  genie task code/polish \"Run type checking and linting\""
echo ""
echo -e "${YELLOW}What happens:${NC}"
echo "  ✓ Task starts immediately in background"
echo "  ✓ Returns task ID instantly"
echo "  ✓ No browser, no blocking"
echo "  ✓ Check status with: genie task monitor <task-id>"
echo ""
read -p "Press Enter to see the actual command (won't execute)..."
echo ""
echo -e "${GREEN}$ genie task code/polish \"Run type checking and linting\"${NC}"
echo ""

# ========================================
# Example 3: Crontab Mode (Scheduled)
# ========================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}⏰ Example 3: Crontab Mode (Scheduled)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${GREEN}Use Case:${NC} Daily standup at 9:05 AM (automated)"
echo -e "${GREEN}Command:${NC}"
echo ""
echo "  5 9 * * * cd /home/namastex/workspace/automagik-genie && genie task daily-standup \"Generate 24h summary for dev branch\" >> /tmp/genie-standup.log 2>&1"
echo ""
echo -e "${YELLOW}What happens:${NC}"
echo "  ✓ Runs automatically every day at 9:05 AM"
echo "  ✓ Analyzes past 24h git activity on dev branch"
echo "  ✓ Sends WhatsApp message to Namastexers group"
echo "  ✓ Logs output to /tmp/genie-standup.log"
echo ""
read -p "Press Enter to see the crontab setup instructions..."
echo ""

# ========================================
# Crontab Setup Instructions
# ========================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📝 Crontab Setup Instructions${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "To add the daily standup to your crontab:"
echo ""
echo "1. Open crontab editor:"
echo "   ${GREEN}crontab -e${NC}"
echo ""
echo "2. Add this line at the bottom:"
echo "   ${YELLOW}5 9 * * * cd /home/namastex/workspace/automagik-genie && genie task daily-standup \"Generate 24h summary for dev branch\" >> /tmp/genie-standup.log 2>&1${NC}"
echo ""
echo "3. Save and exit (Ctrl+X, then Y, then Enter in nano)"
echo ""
echo "4. Verify it's added:"
echo "   ${GREEN}crontab -l${NC}"
echo ""
echo "5. Check logs after it runs:"
echo "   ${GREEN}tail -f /tmp/genie-standup.log${NC}"
echo ""

# ========================================
# Test Daily Standup Manually
# ========================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}🧪 Test Daily Standup NOW (Manual)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Want to test the daily standup right now?"
echo ""
echo "Run this command:"
echo ""
echo -e "${GREEN}genie task daily-standup \"Generate 24h summary for dev branch\"${NC}"
echo ""
echo "Or with browser UI:"
echo ""
echo -e "${GREEN}genie run daily-standup \"Generate 24h summary for dev branch\"${NC}"
echo ""

# ========================================
# Summary
# ========================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📚 Summary${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "Three execution modes:"
echo ""
echo "  ${GREEN}genie run <agent> \"<prompt>\"${NC}"
echo "    → Browser UI, interactive, watch it work"
echo ""
echo "  ${GREEN}genie task <agent> \"<prompt>\"${NC}"
echo "    → Headless, background, returns task ID"
echo ""
echo "  ${GREEN}crontab -e${NC} → Add scheduled automation"
echo "    → Runs automatically on schedule"
echo ""
echo "Daily Standup Target:"
echo "  📱 Namastexers group (WhatsApp)"
echo "  🕘 9:05 AM every day"
echo "  🌿 Analyzes dev branch (past 24h)"
echo ""
echo "Demo complete! 🎉"
echo ""
