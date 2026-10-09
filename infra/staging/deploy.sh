#!/usr/bin/env bash
set -Eeuo pipefail

# Staging deployment (B1-01zc). Run as root on the staging node:
#   ./deploy.sh <image-tag>
# The image couli-api:<image-tag> must already be loaded on the node (docker load).
# Order: take the deployment lock -> check the node files exist -> migrate with the new image ->
# switch all five processes and wait until every health check passes (each requires 30s of
# uptime and a single container start, see compose.yaml) -> confirm RestartCount 0 for all five
# -> on success mark the containers settled, record the tag with a copy of the compose file used
# and remove older images; on a failed health check switch back to the last successful tag (with
# the compose file saved for it) and exit 1. A RestartCount other than 0 records no tag, marks the
# running version as uncertain (when a successful tag exists) and exits 1 with the manual rollback
# command (no automatic rollback there).
# Manual rollback is `./deploy.sh <older tag>`: it uses the compose file saved with that tag when
# there is one, otherwise the compose.yaml next to this script. Redeploying the tag that is both the
# last successful one and the one running uses the compose.yaml next to this script (and saves it
# again on success), so an edited compose.yaml takes effect. While the running version is uncertain
# every `./deploy.sh <tag>` uses the compose file saved with that tag and is refused without one.
# Node credential files are only referenced by path; their contents are never printed.

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy] FAILED: %s\n' "$*" >&2; }

export COULI_API_TAG="${1:?usage: deploy.sh IMAGE_TAG}"
COMPOSE_FILE="$(dirname "$(readlink -f "$0")")/compose.yaml"
SCRIPT_COMPOSE_FILE="$COMPOSE_FILE"
STATE_DIR=/var/lib/couli
STATE_FILE="$STATE_DIR/staging-api.tag"
# The tag the five processes were last switched to (written just before each switch and after a
# rollback switch), whether or not that deployment succeeded.
SWITCHED_FILE="$STATE_DIR/staging-api.switched"
# Written to SWITCHED_FILE after a RestartCount failure: what is running is uncertain. It cannot be
# an image tag (a tag starts with a letter or digit).
DIRTY_MARK='-uncertain-'
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

# First deployment: no recorded tag yet, so there is nothing to roll back to. Without a record of
# the last switch (first run of this script version, left by an older one) the running tag is
# unknown: it is never taken to be the last successful one, so that tag's saved compose is used.
mkdir -p "$STATE_DIR"
touch "$STATE_FILE" "$SWITCHED_FILE"
PREVIOUS_TAG="$(cat "$STATE_FILE")"
SWITCHED_TAG="$(cat "$SWITCHED_FILE")"

# After a RestartCount failure the running version is uncertain: only a tag with a saved compose
# file may be deployed (the edited compose.yaml next to this script may be what broke it), until a
# deployment succeeds again. Refuse before the migration and the switch.
if [[ "$SWITCHED_TAG" == "$DIRTY_MARK" && ! -f "$STATE_DIR/compose.$COULI_API_TAG.yaml" ]]; then
  fail "the last deployment failed its RestartCount check, so what is running is uncertain; no compose file saved with couli-api:$COULI_API_TAG ($STATE_DIR/compose.$COULI_API_TAG.yaml is missing)"
  fail "deploy a tag that has a saved compose file first, e.g. the last successful one: deploy.sh ${PREVIOUS_TAG:-<previous tag>}"
  exit 2
fi

# A tag deployed successfully before has its own compose file saved; an older image may not fit
# the current compose.yaml, so a manual rollback (`deploy.sh <older tag>`) uses the saved one.
# Redeploying the tag that is the last successful one AND is running is not a rollback: it uses
# the compose.yaml next to this script, so an edit to it takes effect and is saved on success.
# After a RestartCount failure the switch record holds DIRTY_MARK, never a tag, so every
# `deploy.sh <tag>` (the last successful one included) uses the saved copy.
if [[ -f "$STATE_DIR/compose.$COULI_API_TAG.yaml" ]]; then
  if [[ "$COULI_API_TAG" == "$PREVIOUS_TAG" && "$COULI_API_TAG" == "$SWITCHED_TAG" ]]; then
    log "couli-api:$COULI_API_TAG is already the running, last successful tag; redeploying with the current compose.yaml next to deploy.sh (saved again on success)"
  else
    COMPOSE_FILE="$STATE_DIR/compose.$COULI_API_TAG.yaml"
    log "using the compose file saved with couli-api:$COULI_API_TAG"
  fi
else
  log "no compose file saved with couli-api:$COULI_API_TAG; using the current compose.yaml next to deploy.sh"
fi

# Everything compose and the migration mount or read must already be on the node. A missing bind
# source would only surface while the running processes are being replaced (and the rollback
# would fail the same way), so stop here, before the migration. Paths only; nothing is read.
if [[ ! -f /etc/couli/staging.env || ! -f /etc/couli/staging-payout.env || ! -f /etc/couli/staging-migrator.env ]]; then
  fail "node env file missing: /etc/couli/staging.env, staging-payout.env and staging-migrator.env are all required (README 1)"
  exit 2
fi
if [[ ! -f /etc/pki/ca.crt ]]; then
  fail "database CA /etc/pki/ca.crt is missing (README 1.1)"
  exit 2
fi
if [[ ! -f /etc/couli-keys/master.key || ! -f /etc/couli-keys/keyring.json ]]; then
  fail "field-encryption key files missing in /etc/couli-keys (master.key, keyring.json; README 1.3)"
  exit 2
fi
if [[ ! -f /etc/couli-jwt/es256.pem || ! -f /etc/couli-jwt/key-id ]]; then
  fail "signing key files missing in /etc/couli-jwt (es256.pem, key-id; README 1.4)"
  exit 2
fi
log "node files present (env files, database CA, key ring, signing key)"

# The migration connects through pg-connection-string, which treats sslmode=verify-ca as
# verify-full (host name checked) unless uselibpqcompat=true is set; staging connects by internal
# IP, which the certificate need not name. Match only; the file is never printed.
if grep -q 'sslmode=verify-ca' /etc/couli/staging-migrator.env; then
  if ! grep -Eq '[?&]uselibpqcompat=true([&[:space:]]|$)' /etc/couli/staging-migrator.env; then
    fail "staging-migrator.env uses sslmode=verify-ca without uselibpqcompat=true; the migration would check the host name (README 1.1)"
    exit 2
  fi
fi

log "deploying couli-api:$COULI_API_TAG (last successful: ${PREVIOUS_TAG:-none})"

# Step 1: migrate with the new image, migrator credentials only. Under set -e a failed
# migration stops here, before any running process is touched.
log "step 1/4: database migration"
docker run --rm --pull never --env-file /etc/couli/staging-migrator.env --volume /etc/pki/ca.crt:/etc/pki/ca.crt:ro "couli-api:$COULI_API_TAG" node packages/db/scripts/migrate.ts
log "step 1/4: migration finished"

# Step 2: recreate all five processes on the new image and wait until every health check
# passes. A check passes only after 30s of uptime and only if the container has started
# once (boot.mjs counts starts; the counter survives a restart and is emptied by the recreate)
# until this script marks the deployment settled after step 3, so a process that crashes or
# restarts even once before then (worker and payout included) fails this step.
log "step 2/4: switching api, stream, worker, admin and payout"
printf '%s\n' "$COULI_API_TAG" > "$SWITCHED_FILE"
if docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env up -d --force-recreate --remove-orphans --wait --wait-timeout 240; then
  log "step 2/4: all five processes healthy, up for 30s, started once"
  # Step 3: Docker's own restart counters must all be 0 before anything is recorded. `up --wait`
  # need not look again at a service it has already seen healthy, so a crash anywhere from the
  # first service becoming healthy until `up --wait` returns can slip past step 2; this catches
  # it. The rollback must then be run by hand (the switch above is the script's only automatic
  # rollback point). With a successful tag recorded the switch record becomes DIRTY_MARK, so the
  # next run uses saved compose files only; a fresh node (no successful tag) keeps the plain retry.
  RESTART_COUNTS="$(docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env ps --all --quiet | xargs -r docker inspect --format '{{.RestartCount}}' | tr '\n' ' ')"
  if [[ "$RESTART_COUNTS" != "0 0 0 0 0 " ]]; then
    fail "expected five containers with RestartCount 0, got: ${RESTART_COUNTS:-none}; no tag recorded"
    printf '%s\n' "${PREVIOUS_TAG:+$DIRTY_MARK}" > "$SWITCHED_FILE"
    fail "roll back by hand: deploy.sh ${PREVIOUS_TAG:-<previous tag>}"
    fail "when a successful tag is recorded the running version is now marked uncertain${PREVIOUS_TAG:+ (the rollback uses $STATE_DIR/compose.$PREVIOUS_TAG.yaml)}: until a deployment succeeds, deploy.sh <tag> uses only the compose file saved with that tag and refuses a tag without one; a fresh node without any successful tag is not marked and may retry"
    exit 1
  fi
  # Only now may a later restart (node reboot) pass the health checks again.
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T api touch /tmp/couli-settled
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T stream touch /tmp/couli-settled
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T worker touch /tmp/couli-settled
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T admin touch /tmp/couli-settled
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T payout touch /tmp/couli-settled
  log "step 3/4: RestartCount 0 for all five; marked settled"
  # Record the tag only after health success; the next deployment rolls back to it, using the
  # compose file saved with it (an older image may not fit a newer compose file).
  printf '%s\n' "$COULI_API_TAG" > "$STATE_FILE"
  # A redeployment of a tag with a saved compose file used that very file: copying it onto itself
  # would fail and, under set -e, report a healthy deployment as failed.
  if [[ ! "$COMPOSE_FILE" -ef "$STATE_DIR/compose.$COULI_API_TAG.yaml" ]]; then
    cp "$COMPOSE_FILE" "$STATE_DIR/compose.$COULI_API_TAG.yaml"
  fi
  log "step 3/4: recorded couli-api:$COULI_API_TAG as last successful (compose file saved with it)"
  # Step 4: keep only the current and the previous successful image (the rollback target);
  # older couli-api images would fill the 20G system disk shared with the database. A repeated
  # deployment of the same tag removes nothing: the image kept by the earlier run is still the
  # rollback target of an operator who goes back to it.
  if [[ "$COULI_API_TAG" == "$PREVIOUS_TAG" ]]; then
    log "step 4/4: same tag as the last successful deployment; no image removed"
  else
    if docker image ls couli-api --format '{{.Tag}}' | grep -vxF -e "$COULI_API_TAG" -e "${PREVIOUS_TAG:-$COULI_API_TAG}" -e '<none>' | xargs -r -I '{}' docker image rm 'couli-api:{}'; then
      log "step 4/4: older couli-api images removed (kept $COULI_API_TAG and ${PREVIOUS_TAG:-none})"
    else
      log "step 4/4: no older couli-api image removed (none left, or one is still in use)"
    fi
    find "$STATE_DIR" -maxdepth 1 -name 'compose.*.yaml' ! -name "compose.$COULI_API_TAG.yaml" ! -name "compose.${PREVIOUS_TAG:-$COULI_API_TAG}.yaml" -delete
  fi
  log "done"
else
  fail "couli-api:$COULI_API_TAG did not become healthy within 240s"
  if [[ -z "$PREVIOUS_TAG" ]]; then
    fail "no previous successful tag recorded; containers left as they are for diagnosis"
    exit 1
  fi
  log "rolling back to couli-api:$PREVIOUS_TAG"
  if [[ -f "$STATE_DIR/compose.$PREVIOUS_TAG.yaml" ]]; then
    COMPOSE_FILE="$STATE_DIR/compose.$PREVIOUS_TAG.yaml"
    log "using the compose file saved with couli-api:$PREVIOUS_TAG"
  else
    # The compose file must match the rollback tag: never start it with the copy saved for
    # another tag (the one selected for the failed deployment).
    COMPOSE_FILE="$SCRIPT_COMPOSE_FILE"
    log "no compose file saved with couli-api:$PREVIOUS_TAG; rolling back with the current compose.yaml next to deploy.sh"
  fi
  export COULI_API_TAG="$PREVIOUS_TAG"
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env up -d --force-recreate --remove-orphans --wait --wait-timeout 240
  printf '%s\n' "$COULI_API_TAG" > "$SWITCHED_FILE"
  # The rolled-back processes are the running version now: let a later restart pass again.
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T api touch /tmp/couli-settled
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T stream touch /tmp/couli-settled
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T worker touch /tmp/couli-settled
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T admin touch /tmp/couli-settled
  docker compose -f "$COMPOSE_FILE" --env-file /etc/couli/staging.env exec -T payout touch /tmp/couli-settled
  fail "rolled back to couli-api:$COULI_API_TAG; the migration is NOT reverted (migrations are forward-only)"
  exit 1
fi
