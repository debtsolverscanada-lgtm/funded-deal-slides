#!/usr/bin/env bash
# Starts Keystone inside a GitHub Codespace. Data stays in keystone/data (git-ignored) for the life of the codespace.
cd "$(dirname "$0")/.." || exit 1
export ADMIN_EMAIL="${ADMIN_EMAIL:-admin@keystone.local}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-keystone-admin}"
export ADMIN_NAME="${ADMIN_NAME:-Admin}"
PIDFILE=/tmp/keystone.pid
[ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null
nohup setsid node server.js > /tmp/keystone.log 2>&1 < /dev/null &
echo $! > "$PIDFILE"
sleep 2
echo "Keystone is running on port ${PORT:-3000}. Sign in as $ADMIN_EMAIL."
[ "$ADMIN_PASSWORD" = "keystone-admin" ] && echo "No ADMIN_PASSWORD secret was set, so the password is: keystone-admin"
[ -z "$MONDAY_API_TOKEN" ] && echo "No MONDAY_API_TOKEN secret was set, so 'Copy from Monday' won't work until you add one."
exit 0
