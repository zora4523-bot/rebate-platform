#!/usr/bin/env bash
set -Eeuo pipefail

# Staging deployment (B1-01zc). Run as root on the staging node:
#   ./deploy.sh <image-tag>
# The image couli-api:<image-tag> must already be loaded on the node (docker load).
# Order: take the deployment lock -> migrate with the new image -> switch all five processes
# and wait until every health check passes (each includes 30s of uptime without a restart)
# -> on success record the tag and remove older images; on failure switch back to the last
# successful tag and exit 1.
# Node credential files are only referenced by path; their contents are never printed.

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] FAILED: %s\n' "$*" >&2; }

export COULI_API_TAG="${1:?usage: deploy.sh IMAGE_TAG}"
COMPOSE_FILE="$(dirname "$(readlink -f "$0")")/compose.yaml"
STATE_DIR=/var/lib/couli
STATE_FILE="$STATE_DIR/staging-api.tag"
LOCK_FILE=/run/lock/couli-staging-deploy.lock

if [[ ! "$COULI_API_TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  fail "image tag must be letters, digits, dot, dash or underscore"
  exit 2
fi

# One deployment at a time: the lock is held on fd 9 until this script exits, covering the
# state read, migration, switch, state write and rollback. A second run exits at once.
mkdir -p /run/lock
exec 9> "$LOCK_FILE"
if ! flock -n 9; then
  fail "another deployment is running (lock $LOCK_FILE); try again after it finishes"
  exit 2
fi

if ! docker image inspect "couli-api:$COULI_API_TAG" > /dev/null; then
  fail "image couli-api:$COULI_API_TAG is not loaded on this node (see README: docker save | ssh ... docker load)"
  exit 2
fi
if [[ ! -f "$COMPOSE_FILE" ]]; then
  fail "compose file not found next to deploy.sh"
  exit 2
fi

# First deployment: no recorded tag yet, so there is nothing to roll back to.
mkdir -p "$STATE_DIR"
touch "$STATE_FILE"
PREVIOUS_TAG="$(cat "$STATE_FILE")"
log "deploying couli-api:$COULI_API_TAG (last successful: ${PREVIOUS_TAG:-none})"

# Step 1: migrate with the new image, migrator credentials only. Under set -e a failed
# migration stops here, before any running process is touched.
log "step 1/4: database migration"
docker run --rm --pull never --env-file /etc/couli/staging-migrator.env --volume /etc/pki/ca.crt:/etc/pki/ca.crt:ro "couli-api:$COULI_API_TAG" node packages/db/scripts/migrate.ts
log "step 1/4: migration finished"

# Step 2: recreate all five processes on the new image and wait until every health check
# passes. The health checks only pass after 30s of uptime, and a restart resets that, so a
# process that crashes or restarts (worker and payout included) fails this step.
log "step 2/4: switching api, stream, worker, admin and payout"
if docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env up -d --force-recreate --remove-orphans --wait --wait-timeout 240; then
  log "step 2/4: all five processes healthy and up for 30s without a restart"
  # Step 3: record the tag only after health success; the next deployment rolls back to it.
  printf '%s\n' "$COULI_API_TAG" > "$STATE_FILE"
  log "step 3/4: recorded couli-api:$COULI_API_TAG as last successful"
  # Step 4: keep only the current and the previous successful image (the rollback target);
  # older couli-api images would fill the 20G system disk shared with the database.
  if docker image ls couli-api --format '{{.Tag}}' | grep -vxF -e "$COULI_API_TAG" -e "${PREVIOUS_TAG:-$COULI_API_TAG}" -e '<none>' | xargs -r -I '{}' docker image rm 'couli-api:{}'; then
    log "step 4/4: older couli-api images removed (kept $COULI_API_TAG and ${PREVIOUS_TAG:-none})"
  else
    log "step 4/4: no older couli-api image removed (none left, or one is still in use)"
  fi
  log "done"
else
  fail "couli-api:$COULI_API_TAG did not become healthy within 240s"
  if [[ -z "$PREVIOUS_TAG" ]]; then
    fail "no previous successful tag recorded; containers left as they are for diagnosis"
    exit 1
  fi
  log "rolling back to couli-api:$PREVIOUS_TAG"
  export COULI_API_TAG="$PREVIOUS_TAG"
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env up -d --force-recreate --remove-orphans --wait --wait-timeout 240
  fail "rolled back to couli-api:$COULI_API_TAG; the migration is NOT reverted (migrations are forward-only)"
  exit 1
fi
