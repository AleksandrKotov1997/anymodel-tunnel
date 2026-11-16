#!/usr/bin/env bash

prepare_ubuntu() {
  [[ $EUID == 0 ]] || fail 'Run the server bootstrap with sudo.'
  . /etc/os-release
  [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail 'Use a fresh Ubuntu 24.04 LTS host.'

  if ! command -v jq >/dev/null || ! command -v openssl >/dev/null; then
    apt-get update
    apt-get install -y ca-certificates curl jq openssl
  fi
  if docker compose version --short >/dev/null 2>&1; then
    return
  fi

  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg \
    -o "$lock_dir/docker.asc"
  install -m 0644 "$lock_dir/docker.asc" /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $VERSION_CODENAME
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}
