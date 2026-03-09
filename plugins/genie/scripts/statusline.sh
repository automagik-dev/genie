#!/bin/bash
# Genie Status Line — meta-programmable agent lifecycle daemon
#
# Runs on every assistant message (debounce 300ms).
# Reads agent-specific triggers from ~/.genie/statusline/<agent>.json
# Falls back to ~/.genie/statusline/_defaults.json
#
# SELF-MODIFIABLE: Agents can edit their own trigger config at runtime:
#   echo '{"triggers":[...]}' > ~/.genie/statusline/$GENIE_AGENT_NAME.json
#
# Trigger format:
#   {
#     "id": "unique-id",
#     "when": "context_pct >= 75",    # condition: context_pct, cost, duration_min
#     "action": "send",               # send = genie send to self
#     "message": "Context at {pct}%", # {pct}, {cost}, {model}, {agent}, {branch}
#     "cooldown_seconds": 300,        # min seconds between fires
#     "enabled": true
#   }

input=$(cat)

# === Parse session data ===
MODEL=$(echo "$input" | jq -r '.model.display_name // "?"')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
DURATION_MS=$(echo "$input" | jq -r '.cost.total_duration_ms // 0')
AGENT_NAME="${GENIE_AGENT_NAME:-}"
WORKTREE=$(echo "$input" | jq -r '.worktree.name // empty')

DURATION_MIN=$((DURATION_MS / 60000))
COST_FMT=$(printf '$%.2f' "$COST")

# === Colors ===
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
CYAN='\033[36m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# === Context bar ===
BAR_WIDTH=12
FILLED=$((PCT * BAR_WIDTH / 100))
EMPTY=$((BAR_WIDTH - FILLED))
BAR=$(printf "%${FILLED}s" | tr ' ' '=')
[ "$EMPTY" -gt 0 ] && BAR="${BAR}$(printf "%${EMPTY}s" | tr ' ' '-')"

if [ "$PCT" -ge 80 ]; then BAR_COLOR="$RED"
elif [ "$PCT" -ge 50 ]; then BAR_COLOR="$YELLOW"
else BAR_COLOR="$GREEN"; fi

# === Git branch ===
BRANCH=""
if git rev-parse --git-dir > /dev/null 2>&1; then
  BRANCH=$(git branch --show-current 2>/dev/null)
fi

# === Active agents ===
AGENTS_COUNT=0
REGISTRY="$HOME/.genie/workers.json"
if [ -f "$REGISTRY" ]; then
  AGENTS_COUNT=$(jq '[.[] | select(.state == "working" or .state == "idle" or .state == "spawning")] | length' "$REGISTRY" 2>/dev/null || echo 0)
fi

# === Build display line ===
LINE="${BOLD}${MODEL}${RESET}"
LINE="${LINE} ${DIM}|${RESET} ${BAR_COLOR}[${BAR}] ${PCT}%${RESET}"
LINE="${LINE} ${DIM}|${RESET} ${DIM}${COST_FMT}${RESET}"

[ "$AGENTS_COUNT" -gt 0 ] && LINE="${LINE} ${DIM}|${RESET} ${CYAN}${AGENTS_COUNT} agents${RESET}"
[ -n "$AGENT_NAME" ] && LINE="${LINE} ${DIM}|${RESET} ${CYAN}@${AGENT_NAME}${RESET}"

if [ -n "$WORKTREE" ]; then
  LINE="${LINE} ${DIM}|${RESET} ${YELLOW}${WORKTREE}${RESET}"
elif [ -n "$BRANCH" ]; then
  LINE="${LINE} ${DIM}|${RESET} ${GREEN}${BRANCH}${RESET}"
fi

echo -e "$LINE"

# === Trigger engine ===
# Skip if no agent name (can't send to self)
[ -z "$AGENT_NAME" ] && exit 0

# Load agent-specific config: team/agent.json → team/_defaults.json → _defaults.json
TEAM="${GENIE_TEAM:-default}"
CONFIG="$HOME/.genie/statusline/${TEAM}/${AGENT_NAME}.json"
[ ! -f "$CONFIG" ] && CONFIG="$HOME/.genie/statusline/${TEAM}/_defaults.json"
[ ! -f "$CONFIG" ] && CONFIG="$HOME/.genie/statusline/_defaults.json"
[ ! -f "$CONFIG" ] && exit 0

COOLDOWN_DIR="$HOME/.genie/statusline/.cooldowns"
mkdir -p "$COOLDOWN_DIR"
NOW=$(date +%s)

# Process each trigger
echo "$input" | jq -c '.triggers = []' > /dev/null 2>&1  # validate jq works
TRIGGERS=$(jq -c '.triggers[]? | select(.enabled == true)' "$CONFIG" 2>/dev/null)

while IFS= read -r trigger; do
  [ -z "$trigger" ] && continue

  ID=$(echo "$trigger" | jq -r '.id')
  WHEN=$(echo "$trigger" | jq -r '.when')
  ACTION=$(echo "$trigger" | jq -r '.action')
  MSG=$(echo "$trigger" | jq -r '.message')
  COOLDOWN=$(echo "$trigger" | jq -r '.cooldown_seconds // 300')

  # Check cooldown
  COOLDOWN_FILE="$COOLDOWN_DIR/${AGENT_NAME}_${ID}"
  if [ -f "$COOLDOWN_FILE" ]; then
    LAST_FIRE=$(cat "$COOLDOWN_FILE")
    ELAPSED=$((NOW - LAST_FIRE))
    [ "$ELAPSED" -lt "$COOLDOWN" ] && continue
  fi

  # Evaluate condition
  FIRED=false
  case "$WHEN" in
    *context_pct*)
      THRESHOLD=$(echo "$WHEN" | grep -oP '\d+')
      OP=$(echo "$WHEN" | grep -oP '>=|<=|>|<|==')
      case "$OP" in
        ">=") [ "$PCT" -ge "$THRESHOLD" ] && FIRED=true ;;
        ">")  [ "$PCT" -gt "$THRESHOLD" ] && FIRED=true ;;
        "<=") [ "$PCT" -le "$THRESHOLD" ] && FIRED=true ;;
        "<")  [ "$PCT" -lt "$THRESHOLD" ] && FIRED=true ;;
        "==") [ "$PCT" -eq "$THRESHOLD" ] && FIRED=true ;;
      esac
      ;;
    *cost*)
      THRESHOLD=$(echo "$WHEN" | grep -oP '[\d.]+')
      # Compare as integers (cents)
      COST_CENTS=$(printf '%.0f' "$(echo "$COST * 100" | bc 2>/dev/null || echo 0)")
      THRESH_CENTS=$(printf '%.0f' "$(echo "$THRESHOLD * 100" | bc 2>/dev/null || echo 0)")
      [ "$COST_CENTS" -ge "$THRESH_CENTS" ] 2>/dev/null && FIRED=true
      ;;
    *duration_min*)
      THRESHOLD=$(echo "$WHEN" | grep -oP '\d+')
      [ "$DURATION_MIN" -ge "$THRESHOLD" ] && FIRED=true
      ;;
  esac

  if [ "$FIRED" = true ]; then
    # Interpolate message
    MSG=$(echo "$MSG" | sed \
      -e "s/{pct}/$PCT/g" \
      -e "s/{cost}/${COST_FMT}/g" \
      -e "s/{model}/$MODEL/g" \
      -e "s/{agent}/$AGENT_NAME/g" \
      -e "s/{team}/$TEAM/g" \
      -e "s/{branch}/$BRANCH/g" \
      -e "s/{duration}/${DURATION_MIN}m/g")

    # Execute action
    case "$ACTION" in
      send)
        genie send --to "$AGENT_NAME" "$MSG" > /dev/null 2>&1 &
        ;;
    esac

    # Record cooldown
    echo "$NOW" > "$COOLDOWN_FILE"
  fi
done <<< "$TRIGGERS"

exit 0
