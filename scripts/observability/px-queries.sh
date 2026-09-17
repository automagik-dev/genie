#!/bin/bash
# Phoenix CLI (px) queries over the cc-* projects scripts/observability/backfill.ts writes and the
# code-annotator/v1 session annotations scripts/observability/annotate.ts upserts. Read-only.
# Requires: the Phoenix CLI (`px`, npm package @arizeai/phoenix-cli) and python3 on PATH.
# Usage: scripts/observability/px-queries.sh [project]   (default cc-genie)
set -uo pipefail
export PHOENIX_ENDPOINT="${PHOENIX_ENDPOINT:-http://127.0.0.1:6006}"
P="${1:-cc-genie}"
gq() { px api graphql "$1" 2>/dev/null; }

echo "## Projects (traces, sessions, cost)"
gq '{ projects(first:100) { edges { node { name traceCount sessionCount costSummary { total { cost tokens } } } } } }' \
 | python3 -c "
import sys,json; d=json.load(sys.stdin)
rows=[e['node'] for e in d['data']['projects']['edges'] if e['node']['name'].startswith('cc-')]
rows.sort(key=lambda n:-(n['costSummary']['total']['cost'] or 0))
print('| project | traces | sessions | cost | tokens |'); print('|---|---|---|---|---|')
for n in rows: print(f\"| {n['name']} | {n['traceCount']} | {n['sessionCount']} | \${n['costSummary']['total']['cost'] or 0:,.0f} | {(n['costSummary']['total']['tokens'] or 0)/1e6:,.0f}M |\")"

echo; echo "## Sessions flagged by the annotator (session filter expressions)"
for cond in "session_annotations['polling_share'].score > 0.05" "session_annotations['max_context'].score > 500000" "session_annotations['waste_usd'].score > 5" "session_annotations['interrupts'].score > 3"; do
  n=$(gq "{ projects(first:100) { edges { node { name sessions(first:300, sessionFilterCondition: $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$cond")) { edges { node { sessionId } } } } } } }" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(len(e['node']['sessions']['edges']) for e in d['data']['projects']['edges']))")
  echo "- \`$cond\` → $n sessions"
done

echo; echo "## Span filters (traceCount per project)"
for cond in "span_kind == 'TOOL' and status_code == 'ERROR'" "span_kind == 'LLM' and llm.token_count.prompt > 500000" "metadata['bash_head'] == 'git'" "metadata['prompt_kind'] == 'human'" "name == 'AskUserQuestion'"; do
  gq "{ projects(first:100) { edges { node { name traceCount(filterCondition: $(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$cond")) } } } }" \
   | python3 -c "
import sys,json; d=json.load(sys.stdin); c=sys.argv[1]
rows={e['node']['name']:e['node']['traceCount'] for e in d['data']['projects']['edges'] if (e['node']['traceCount'] or 0)>0 and e['node']['name'].startswith('cc-')}
print(f'- \`{c}\` → ' + ', '.join(f'{k} {v}' for k,v in sorted(rows.items(), key=lambda kv:-kv[1])[:6]))" "$cond"
done

echo; echo "## Top models by cost ($P)"
gq "{ projects(first:100) { edges { node { name topModelsByCost(timeRange:{start:\"2026-01-01T00:00:00Z\", end:\"2027-01-01T00:00:00Z\"}) { name costSummary { total { cost tokens } } } } } } }" \
 | python3 -c "
import sys,json; d=json.load(sys.stdin); P=sys.argv[1]
for e in d['data']['projects']['edges']:
    if e['node']['name']==P:
        for m in e['node']['topModelsByCost'] or []:
            t=(m.get('costSummary') or {}).get('total') or {}; print(f\"- {m['name']}: \${t.get('cost') or 0:,.0f} / {(t.get('tokens') or 0)/1e6:,.0f}M tokens\")" "$P"

echo; echo "## Worst sessions by waste (px session list --include-annotations, $P)"
px session list --project "$P" --include-annotations -n 200 --format json --no-progress 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin); sess=d if isinstance(d,list) else d.get('sessions', d.get('data', []))
def score(s,name):
    for a in s.get('annotations',[]) or s.get('session_annotations',[]) or []:
        if a.get('name')==name: return (a.get('result') or a).get('score') or 0
    return 0
sess.sort(key=lambda s:-score(s,'waste_usd'))
print('| session | total_usd | waste_usd | polling_share | max_context | interrupts |'); print('|---|---|---|---|---|---|')
for s in sess[:8]:
    sid=(s.get('session_id') or s.get('sessionId') or '')[:8]
    print(f\"| {sid} | \${score(s,'total_usd'):,.0f} | \${score(s,'waste_usd'):,.2f} | {score(s,'polling_share'):.1%} | {score(s,'max_context')/1e3:,.0f}k | {score(s,'interrupts'):.0f} |\")" 2>/dev/null || echo "(px session list JSON shape not recognized; see px session list --project $P --include-annotations)"

echo; echo "## Failing Bash spans, newest first (px span list)"
px span list --project "$P" --span-kind TOOL --status-code ERROR --name Bash -n 5 --format json --no-progress 2>/dev/null | python3 -c "
import sys,json
d=json.load(sys.stdin); spans=d if isinstance(d,list) else d.get('spans', d.get('data', []))
for s in spans[:5]:
    a=s.get('attributes',{}); print('-', (a.get('input.value') or a.get('input',{}).get('value','') or '')[:90].replace('\n',' '), '→', (s.get('status_message') or '')[:60].replace('\n',' '))" 2>/dev/null || true
