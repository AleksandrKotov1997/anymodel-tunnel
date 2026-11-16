#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
source "$script_dir/lib/runtime.sh"
source "$script_dir/lib/profiles.sh"

usage() {
  printf 'Usage: %s {issue|show|revoke} NAME\n' "${0##*/}"
}

if [[ ${1:-} == -h || ${1:-} == --help ]]; then
  usage
  exit 0
fi
if [[ $# != 2 || ! "$1" =~ ^(issue|show|revoke)$ || ! "$2" =~ ^[a-z][a-z0-9_-]{0,31}$ ]]; then
  usage >&2
  exit 2
fi

lock_state
[[ -f "$active_config" && -f "$identity_file" ]] || fail 'Run bootstrap first.'
mode=$(jq -er '.mode' "$identity_file")
port=$(jq -r '.port // ""' "$identity_file")
configure_binding "$mode" "$port"
case "$1" in
  issue) check_docker; issue_profile "$2" ;;
  show) export_profile "$2" ;;
  revoke) check_docker; revoke_profile "$2" ;;
esac
