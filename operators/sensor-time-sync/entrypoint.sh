#!/bin/sh
# Hera entrypoint wrapper: intercepts --describe, else runs the command.
#
# multi_source_synchronizer exits 0 even when alignment fails: main.cpp
# catches the alignment exception, logs "Alignment failed: ...", but falls
# through to `return 0` instead of propagating failure — confirmed by running
# it directly against a real session with insufficient sync motion. So its
# exit code can't be trusted; verify the promised offset file actually landed
# instead (it's only written on the success path, inside the try block).
set -e
if [ "$1" = "--describe" ]; then
    cat /operator.json
    exit 0
fi
# Tee stdout to a scratch file so we can also pull the tool's own diagnostic
# ("ERROR | Alignment failed: ...") into the failure reason below — that line
# is on stdout, but dag.rs's job_failed `reason` is built from stderr only, so
# without this the reason the app shows is just a generic "no output" message
# with no actual cause (confirmed confusing in practice: the app's stderr-only
# reason line gave no hint whether this was "data lacks sync motion" vs some
# other failure, forcing a manual re-run to find out).
LOG=$(mktemp)
"$@" | tee "$LOG"
if [ ! -s /output/sync_offset.txt ]; then
    TOOL_ERROR=$(grep -m1 "ERROR" "$LOG" | sed -e 's/\x1b\[[0-9;]*m//g' -e 's/^[^|]*| *//' || true)
    rm -f "$LOG"
    if [ -n "$TOOL_ERROR" ]; then
        echo "$TOOL_ERROR" >&2
    else
        echo "multi_source_synchronizer 未写出 sync_offset.txt，且日志中未找到 ERROR 行（可能提前崩溃），请查看完整日志" >&2
    fi
    exit 1
fi
rm -f "$LOG"
