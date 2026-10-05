#!/bin/sh
set -eu
adb start-server
exec "$@"
