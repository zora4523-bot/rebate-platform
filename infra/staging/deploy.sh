#!/usr/bin/env bash
set -Eeuo pipefail

# Staging deployment (B1-01zc). Run as root on the staging node:
#   ./deploy.sh <image-tag>
# The image couli-api:<image-tag> must already be loaded on the node (docker load).
# Order: migrate with the new image -> switch all five processes and wait for health ->
# on success record the tag; on failure switch back to the last successful tag and exit 1.
# Node credential files are only referenced by path; their contents are never printed.

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] FAILED: %s\n' "$*" >&2; }

export COULI_API_TAG="${1:?usage: deploy.sh IMAGE_TAG}"
COMPOSE_FILE="$(dirname "$(readlink -f "$0")")/compose.yaml"
STATE_DIR=/var/lib/couli
STATE_FILE="$STATE_DIR/staging-api.tag"

if [[ ! "$COULI_API_TAG" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ ]]; then
  fail "image tag must be letters, digits, dot, dash or underscore"
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
log "step 1/3: database migration"
docker run --rm --pull never --env-file /etc/couli/staging-migrator.env "couli-api:$COULI_API_TAG" node packages/db/scripts/migrate.ts
log "step 1/3: migration finished"

# Step 2: recreate all five processes on the new image and wait until every health check passes.
log "step 2/3: switching api, stream, worker, admin and payout"
if docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env up -d --force-recreate --remove-orphans --wait --wait-timeout 180; then
  log "step 2/3: all processes running and healthy"
  # Step 3: record the tag only after health success; the next deployment rolls back to it.
  printf '%s\n' "$COULI_API_TAG" > "$STATE_FILE"
  log "step 3/3: recorded couli-api:$COULI_API_TAG as last successful"
  log "done"
else
  fail "couli-api:$COULI_API_TAG did not become healthy within 180s"
  if [[ -z "$PREVIOUS_TAG" ]]; then
    fail "no previous successful tag recorded; containers left as they are for diagnosis"
    exit 1
  fi
  log "rolling back to couli-api:$PREVIOUS_TAG"
  export COULI_API_TAG="$PREVIOUS_TAG"
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env up -d --force-recreate --remove-orphans --wait --wait-timeout 180
  fail "rolled back to couli-api:$COULI_API_TAG; the migration is NOT reverted (migrations are forward-only)"
  exit 1
fi
