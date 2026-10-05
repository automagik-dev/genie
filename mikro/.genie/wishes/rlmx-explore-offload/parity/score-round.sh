#!/usr/bin/env bash
# score-round.sh <roundLabel> — mechanical rubric over one round's runs.
set -u
round="$1"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for n in 1 2 3 4 5 6; do
  f="$here/runs/$round/task-$n.json"
  [ -f "$f" ] || { echo "t$n: (no run)"; continue; }
  node "$here/score-task.mjs" "$f" "$n" 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
foot=json.load(open('$f')).get('footer','')
print(f\"t{d['task']}: c2={d['c2'][:110]} | c3={d['c3'][:110]} | facts need {d['factsNeed']} termHit={d['factTermHits']} pathHit={d['factPathHits']} | cites={d['citations']} chars={d['answerChars']}\")
print(f'      {foot}')
"
done
