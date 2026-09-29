#!/bin/bash
# Average CPU (percent of one core, as Activity Monitor shows it) of Obsidian's processes and
# WindowServer over N seconds (default 10). Run it while a reply streams; take no screenshots.
secs=${1:-10}
pids=$(pgrep -f 'Obsidian Helper|MacOS/Obsidian'; pgrep -x WindowServer)
for p in $pids; do
  base=$(basename "$(ps -p "$p" -o comm=)")
  type=$(ps -p "$p" -o command= | sed -nE 's/.*--type=([a-z]+).*/\1/p')
  printf '%s\t%s\n' "$p" "${base}${type:+ [$type]}"
done > "${TMPDIR:-/tmp}/vc-cpu-labels"
top -l $((secs + 1)) -s 1 -stats pid,cpu $(printf -- '-pid %s ' $pids) |
  awk 'NR == FNR { name[$1] = substr($0, index($0, "\t") + 1); next }
    /^[0-9]+ +[0-9.]+$/ { seen[$1]++; if (seen[$1] > 1) { sum[$1] += $2; count[$1]++ } }
    END { for (p in sum) if (count[p]) printf "%-34s %5.1f%%\n", name[p], sum[p] / count[p] }' "${TMPDIR:-/tmp}/vc-cpu-labels" - | sort -k2 -nr
