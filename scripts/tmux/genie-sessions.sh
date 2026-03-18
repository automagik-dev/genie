#!/usr/bin/env bash
# List all tmux sessions formatted for status bar display
# Active session gets purple highlight, others get dim text

current_session="$1"
if [ -z "$current_session" ]; then
  current_session=$(tmux display-message -p '#{session_name}' 2>/dev/null)
fi

output=""
for sess in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | sort); do
  if [ "$sess" = "$current_session" ]; then
    output+="#[bg=#7b2ff7,fg=#e0e0e0,bold] $sess #[bg=#16213e,fg=#7b2ff7,nobold]"
  else
    output+="#[fg=#b8a9c9,bg=#16213e] $sess "
  fi
done

echo "$output"
