#!/bin/sh
set -e
if [ "$1" = "--describe" ]; then
    cat /operator.json
    exit 0
fi
for _setup in /opt/ros/*/setup.sh; do
    [ -f "$_setup" ] && . "$_setup" && break
done
exec "$@"
