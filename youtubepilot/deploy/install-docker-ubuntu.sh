#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run with sudo: sudo ./deploy/install-docker-ubuntu.sh" >&2
  exit 1
fi

apt-get update
apt-get install -y ca-certificates curl gnupg unzip openssl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
cat > /etc/apt/sources.list.d/docker.sources <<SOURCES
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
SOURCES
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
if [[ -n ${SUDO_USER:-} && ${SUDO_USER} != root ]]; then
  usermod -aG docker "$SUDO_USER"
fi

echo "Docker installed. Sign out and reconnect, or run: newgrp docker"
docker --version
docker compose version
