#!/bin/sh
# Hera entrypoint wrapper: intercepts --describe, else exec's the command.
set -e
if [ "$1" = "--describe" ]; then
    cat /operator.json
    exit 0
fi
exec "$@"
