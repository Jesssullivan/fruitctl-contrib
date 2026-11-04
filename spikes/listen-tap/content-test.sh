#!/bin/bash
# Bounded PZM content test for the listen tap spike (TIN-5509, TIN-7844).
# Play only at or below -60 dBFS, under 10 s, on an output the operator confirms is muted.
# mode file: capture to a file. mode fifo: capture to stdout through open --stdout
# into a FIFO; this script then prints the FIFO to its own stdout for ssh.
# Version 0.2 streams per callback with a ListenStreamHeaderV1 line.
set -u
D=${LISTEN_TAP_DIR:-$(cd "$(dirname "$0")" && pwd)}
cd "$D" || exit 2
mode=${1:-file}; run=${2:-1}
SECONDS_CAP=${CAPTURE_SECONDS:-4.5}
V1=(--source-kind test-audio --source-bundle-id com.apple.afplay --start-bar 1 --pre-roll 1 --tail 1
    --target-first 2 --target-last "${TARGET_LAST:-4}")
APP=$D/ListenTapStream.app
pgrep -f 'ListenTapStream.app/Contents/MacOS/listen-tap' >/dev/null && { echo '{"event":"refused","why":"spike already running"}' >&2; exit 3; }
pgrep -lf 'MacOS/Logic Pro' >/dev/null && { echo '{"event":"refused","why":"Logic is running"}' >&2; exit 3; }
rm -f "ct-$mode-$run".* ct.fifo
/usr/bin/afplay "${TONE_WAV:-tone-m60.wav}" & AP=$!
# wait for afplay to own a Core Audio process object (at most 1 s)
for _ in 1 2 3 4 5 6 7 8 9 10; do ./listen-tap processes | grep -q "\"pid\":$AP," && break; sleep 0.1; done
./listen-tap processes | grep "\"pid\":$AP," > "ct-$mode-$run.proc" || echo '{"event":"no-process-object"}' > "ct-$mode-$run.proc"
start=$(perl -MTime::HiRes -e 'printf "%.6f", Time::HiRes::time()')
if [ "$mode" = fifo ]; then
  mkfifo ct.fifo
  /usr/bin/open -n --stdout "$D/ct.fifo" --stderr "$D/ct-$mode-$run.err" "$APP" --args capture --pid "$AP" --seconds "$SECONDS_CAP" --mute "${V1[@]}" --stdout &
  OP=$!
  timeout 15 cat ct.fifo   # to ssh stdout
else
  timeout 15 /usr/bin/open -n -W --stdout "$D/ct-$mode-$run.out" --stderr "$D/ct-$mode-$run.err" "$APP" --args capture --pid "$AP" --seconds "$SECONDS_CAP" --mute "${V1[@]}" --out "$D/ct-$mode-$run.lstn"
fi
# hard bounds: end the spike and the tone whatever happened
for _ in $(seq 1 100); do pgrep -f 'ListenTapStream.app/Contents/MacOS/listen-tap' >/dev/null || break; sleep 0.1; done
pkill -f 'ListenTapStream.app/Contents/MacOS/listen-tap' && echo '{"event":"killed-spike"}' >> "ct-$mode-$run.err"
kill "$AP" 2>/dev/null; wait "$AP" 2>/dev/null
[ "$mode" = fifo ] && { wait "$OP" 2>/dev/null; rm -f ct.fifo; }
echo "{\"event\":\"script-done\",\"mode\":\"$mode\",\"start\":\"$start\"}" >> "ct-$mode-$run.err"
