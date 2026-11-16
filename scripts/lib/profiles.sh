#!/usr/bin/env bash

has_profile() {
  jq -e --arg name "$1" 'any(.inbounds[0].settings.clients[]; .email == $name)' \
    "$active_config" >/dev/null
}

write_profile() {
  local name=$1 config=$2
  jq -er --arg name "$name" --arg port "$ANYMODEL_PORT" --slurpfile identity "$identity_file" '
    $identity[0] as $server |
    .inbounds[0].settings.clients[] | select(.email == $name) |
    "vless://" + .id + "@" + $server.address + ":" + $port +
    "?encryption=none&security=reality&type=tcp&flow=xtls-rprx-vision&fp=chrome" +
    "&sni=" + ($server.sni | @uri) + "&pbk=" + $server.publicKey +
    "&sid=" + $server.shortId + "&spx=%2F#" + ($name | @uri)
  ' "$config" > "$lock_dir/profile.vless"
}

issue_profile() {
  local name=$1 candidate="$lock_dir/xray.json" image
  if has_profile "$name"; then
    fail 'That profile already exists. Use show to export it again.'
  fi
  image=$(compose config --images)
  docker run --rm --network none "$image" uuid > "$lock_dir/uuid.txt"
  jq -e --arg name "$name" --rawfile uuid "$lock_dir/uuid.txt" '
    ($uuid | rtrimstr("\n")) as $id |
    select($id | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) |
    .inbounds[0].settings.clients += [{id: $id, email: $name, flow: "xtls-rprx-vision"}]
  ' "$active_config" > "$candidate" || fail 'Could not generate the profile UUID.'
  write_profile "$name" "$candidate"
  apply_config "$candidate" || fail 'The new profile could not be activated.'
  mv -f -- "$lock_dir/profile.vless" "$state_dir/$name.vless"
  printf '%s\n' "$state_dir/$name.vless"
}

export_profile() {
  local name=$1
  has_profile "$name" || fail 'Profile not found.'
  write_profile "$name" "$active_config"
  mv -f -- "$lock_dir/profile.vless" "$state_dir/$name.vless"
  printf '%s\n' "$state_dir/$name.vless"
}

revoke_profile() {
  local name=$1 candidate="$lock_dir/xray.json"
  has_profile "$name" || fail 'Profile not found.'
  jq -e --arg name "$name" \
    '.inbounds[0].settings.clients |= map(select(.email != $name))' \
    "$active_config" > "$candidate"
  apply_config "$candidate" || fail 'The profile could not be revoked.'
  rm -f -- "$state_dir/$name.vless"
  printf 'Revoked %s.\n' "$name"
}
