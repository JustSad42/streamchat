#!/usr/bin/env bash
# StreamChat server installer for Ubuntu / Debian (e.g. a Hetzner VPS).
#
#   curl -fsSL https://raw.githubusercontent.com/JustSad42/streamchat/main/install.sh | sudo bash
#
# Installs Docker and Tailscale if they're missing, downloads the latest StreamChat release to
# /opt/streamchat, starts it, makes the app reachable privately on your tailnet, makes the Kick
# webhook port public with Tailscale Funnel, and turns on nightly updates. Safe to run again.
set -euo pipefail

REPO="JustSad42/streamchat"
DIR="/opt/streamchat"

say()  { printf '\033[1;35m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Run this as root (put sudo in front)."
command -v apt-get >/dev/null || die "This installer supports Ubuntu and Debian."

say "Installing basics"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar >/dev/null

if ! command -v docker >/dev/null; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose is missing. Install the docker-compose-plugin package and run this again."

if ! command -v tailscale >/dev/null; then
  say "Installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale status >/dev/null 2>&1; then
  say "Sign this server in to Tailscale: open the link below in your browser."
  tailscale up
fi

say "Downloading the latest StreamChat"
mkdir -p "$DIR"
api="https://api.github.com/repos/$REPO/releases/latest"
url=$(curl -fsSL -H 'User-Agent: streamchat-install' "$api" | grep -o '"browser_download_url": *"[^"]*streamchat-server-[^"]*\.tar\.gz"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$url" ] || die "Couldn't find a StreamChat server download on GitHub."
tmp=$(mktemp -d)
curl -fsSL "$url" -o "$tmp/server.tar.gz"
rm -rf "$DIR/app.new" && mkdir -p "$DIR/app.new"
tar -xzf "$tmp/server.tar.gz" -C "$DIR/app.new"
rm -rf "$tmp"
rm -rf "$DIR/app" && mv "$DIR/app.new" "$DIR/app"
install -m 755 "$DIR/app/deploy/streamchat" /usr/local/bin/streamchat

exec /usr/local/bin/streamchat setup
