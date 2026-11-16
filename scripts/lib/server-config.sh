#!/usr/bin/env bash

prepare_server_config() {
  local address=$1 sni=$2 mode=$3 candidate=$4
  local image clients_file="$lock_dir/clients.json"

  if [[ -f "$identity_file" ]]; then
    jq -e --arg address "$address" --arg sni "$sni" --arg mode "$mode" \
      --argjson port "$ANYMODEL_PORT" '
        .address == $address and .sni == $sni and .mode == $mode and
        (.port // (if .mode == "local" then 9443 else 443 end)) == $port
      ' "$identity_file" >/dev/null || fail 'Existing state uses different deployment parameters.'
  else
    image=$(compose config --images)
    docker run --rm --network none "$image" x25519 > "$lock_dir/keypair.txt"
    openssl rand -hex 8 > "$lock_dir/short-id.txt"
    jq -en --arg address "$address" --arg sni "$sni" --arg mode "$mode" \
      --argjson port "$ANYMODEL_PORT" --rawfile pair "$lock_dir/keypair.txt" --rawfile sid "$lock_dir/short-id.txt" '
        def key($label):
          $pair | split("\n")[] | select(startswith($label)) | ltrimstr($label);
        {
          $address, $sni, $mode, $port,
          privateKey: key("PrivateKey: "),
          publicKey: key("Password (PublicKey): "),
          shortId: ($sid | rtrimstr("\n"))
        } | select((.privateKey | test("^[A-Za-z0-9_-]{43}$")) and
                   (.publicKey | test("^[A-Za-z0-9_-]{43}$")) and
                   (.shortId | test("^[a-f0-9]{16}$")))
      ' > "$lock_dir/identity.json" || fail 'Could not generate a valid REALITY key pair.'
    mv -- "$lock_dir/identity.json" "$identity_file"
  fi

  if [[ -f "$active_config" ]]; then
    jq -e '.inbounds[0].settings.clients | arrays' "$active_config" > "$clients_file"
  else
    printf '[]\n' > "$clients_file"
  fi

  jq --slurpfile identity "$identity_file" --slurpfile clients "$clients_file" '
    $identity[0] as $id |
    .inbounds[0].settings.clients = $clients[0] |
    .inbounds[0].streamSettings.realitySettings += {
      target: ($id.sni + ":443"),
      serverNames: [$id.sni],
      privateKey: $id.privateKey,
      shortIds: [$id.shortId]
    }
  ' "$project_root/deploy/xray.json" > "$candidate"
}
