#!/bin/sh
set -eu

if [ -z "${ARIA2_RPC_SECRET:-}" ]; then
  echo "ARIA2_RPC_SECRET is required" >&2
  exit 1
fi

# Build the runtime config in a private file so the secret is not on the command line.
umask 077
CONF=/tmp/aria2.conf
SESSION=/downloads/.aria2.session
touch "$SESSION"
cp /etc/aria2/aria2.conf "$CONF"
{
  echo "input-file=${SESSION}"
  echo "save-session=${SESSION}"
  echo "save-session-interval=30"
  echo "rpc-secret=${ARIA2_RPC_SECRET}"
  echo "seed-time=${SEED_TIME_MIN:-0}"
  if [ -n "${ARIA2_BT_TRACKERS:-}" ]; then
    echo "bt-tracker=${ARIA2_BT_TRACKERS}"
  fi
} >> "$CONF"

exec aria2c --conf-path="$CONF"
