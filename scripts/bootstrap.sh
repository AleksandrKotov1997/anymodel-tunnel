#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/lib/runtime.sh"
source "$script_dir/lib/install-docker.sh"
source "$script_dir/lib/server-config.sh"

usage() {
  printf 'Usage: %s [--local] ADDRESS REALITY_SNI\n' "${0##*/}"
}

valid_host() {
  local label
  local -a labels
  [[ $# == 1 && ${#1} -le 253 && "$1" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ && "$1" != *. ]] || return 1
  IFS=. read -r -a labels <<< "$1"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || return 1
  done
}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  usage
  exit 0
fi
mode=server
if [[ ${1:-} == --local ]]; then
  mode=local
  shift
fi
if [[ $# != 2 ]] || ! valid_host "$1" || ! valid_host "$2" ||
  [[ "$2" != *.* || "$2" != *[[:alpha:]]* || "$1" == "$2" ]]; then
  usage >&2
  exit 2
fi
address=$1
sni=$2

if [[ "$mode" == server && $EUID != 0 ]]; then
  fail 'Use sudo on the dedicated Ubuntu host.'
fi
lock_state
configure_binding "$mode"
if [[ "$mode" == server ]]; then
  prepare_ubuntu
fi
command -v jq >/dev/null || fail 'jq is required.'
command -v openssl >/dev/null || fail 'OpenSSL is required.'
check_docker

candidate="$lock_dir/xray.json"
prepare_server_config "$address" "$sni" "$mode" "$candidate"
apply_config "$candidate" || fail 'Could not apply the Xray configuration.'
printf 'Xray is running on %s:%s/tcp.\n' "$ANYMODEL_BIND" "$ANYMODEL_PORT"
