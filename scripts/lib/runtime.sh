#!/usr/bin/env bash

project_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
state_dir=${ANYMODEL_STATE:-${HOME}/.anymodel-tunnel}

fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

lock_state() {
  umask 077
  [[ "$state_dir" == /* && "$state_dir" != / ]] || fail 'ANYMODEL_STATE must be an absolute directory.'
  mkdir -p -- "$state_dir"
  state_dir=$(cd -- "$state_dir" && pwd -P)
  case "$state_dir/" in
    "$project_root/"*|/|/var/|/var/lib/|/tmp/|/private/tmp/|"$HOME/")
      fail 'Use a dedicated state directory outside the repository.' ;;
  esac
  [[ "$project_root/" != "$state_dir/"* ]] || fail 'The state cannot contain the repository.'
  [[ -O "$state_dir" ]] || fail 'The current user must own the state directory.'
  if [[ ! -f "$state_dir/.anymodel-state" ]]; then
    [[ -z "$(ls -A -- "$state_dir")" ]] || fail 'The state directory must be empty on first use.'
    : > "$state_dir/.anymodel-state"
  fi
  chmod 700 "$state_dir"
  lock_dir="$state_dir/.lock"
  mkdir "$lock_dir" || fail 'The state is locked by another operation.'
  trap 'rm -rf -- "$lock_dir"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  printf '%s\n' "$$" > "$lock_dir/pid"
  active_config="$state_dir/xray.json"
  identity_file="$state_dir/identity.json"
  export ANYMODEL_CONFIG="$active_config"
}

compose() {
  docker compose --env-file /dev/null -p anymodel-tunnel -f "$project_root/deploy/compose.yaml" "$@"
}

configure_binding() {
  case "$1" in
    local) export ANYMODEL_BIND=127.0.0.1 ANYMODEL_PORT=9443 ;;
    server) export ANYMODEL_BIND=0.0.0.0 ANYMODEL_PORT=443 ;;
    *) fail 'Invalid deployment mode in state.' ;;
  esac
}

check_docker() {
  docker compose version --short >/dev/null || fail 'Docker Compose CLI is required.'
  docker info --format '{{.ServerVersion}}' >/dev/null || fail 'Cannot connect to Docker.'
}

validate_config() {
  local candidate=$1
  ANYMODEL_CONFIG="$candidate" compose config --quiet || return 1
  if ! ANYMODEL_CONFIG="$candidate" compose run --rm --no-deps -T xray \
    run -test -config /run/xray.json > "$state_dir/validation.log" 2>&1; then
    printf 'Xray validation failed. See %s/validation.log.\n' "$state_dir" >&2
    return 1
  fi
  rm -f -- "$state_dir/validation.log"
}

start_xray() {
  local container revision
  revision=$(openssl dgst -sha256 -r "$active_config" | cut -d ' ' -f 1) || return 1
  ANYMODEL_REVISION="$revision" compose up -d --wait --wait-timeout 15 "$@" xray || return 1
  container=$(compose ps -q xray) || return 1
  sleep 1
  [[ $(docker inspect --format '{{.State.Status}}' "$container") == running ]]
}

apply_config() {
  local candidate=$1 previous="$lock_dir/previous.json"
  # The file is readable by the container UID. Its host directory is mode 0700.
  chmod 644 "$candidate"
  validate_config "$candidate" || return 1
  if cmp -s -- "$candidate" "$active_config"; then
    start_xray
    return
  fi
  if [[ -f "$active_config" ]]; then
    cp -p -- "$active_config" "$previous" || return 1
  fi
  mv -f -- "$candidate" "$active_config" || return 1
  if start_xray --force-recreate; then
    return 0
  fi
  if [[ -f "$previous" ]]; then
    mv -f -- "$previous" "$active_config" && start_xray --force-recreate ||
      printf 'Automatic runtime rollback failed. Inspect Docker.\n' >&2
  else
    compose rm --stop --force xray
    rm -f -- "$active_config"
  fi
  return 1
}
