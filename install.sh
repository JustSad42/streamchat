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
# Timeouts + retries so a stuck connection fails with a message instead of hanging; -4 as a fallback
# for servers whose IPv6 route to GitHub is broken.
fetch() { curl -fsSL --connect-timeout 15 --max-time 120 --retry 2 -H 'User-Agent: streamchat-install' "$@" \
  || curl -4 -fsSL --connect-timeout 15 --max-time 120 --retry 2 -H 'User-Agent: streamchat-install' "$@"; }
tag=$(fetch "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)
if [ -z "$tag" ]; then # API unreachable or rate-limited: read the tag from the releases page redirect
  tag=$(fetch -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest" 2>/dev/null | sed -n 's#.*/tag/\(v[^/]*\)$#\1#p' || true)
fi
[ -n "$tag" ] || die "Couldn't reach GitHub from this server. Check: curl -I https://github.com"
url="https://github.com/$REPO/releases/download/$tag/streamchat-server-${tag#v}.tar.gz"
say "Getting StreamChat ${tag#v}"
tmp=$(mktemp -d)
fetch "$url" -o "$tmp/server.tar.gz" || die "The download failed: $url"
want=$(fetch "$url.sha256" 2>/dev/null | awk '{print $1}')
[ "${#want}" = 64 ] || die "That release has no checksum, so it wasn't installed: $url"
echo "$want  $tmp/server.tar.gz" | sha256sum -c --status || die "The download doesn't match its checksum, so it wasn't installed."
rm -rf "$DIR/app.new" && mkdir -p "$DIR/app.new"
tar -xzf "$tmp/server.tar.gz" -C "$DIR/app.new"
rm -rf "$tmp"
rm -rf "$DIR/app" && mv "$DIR/app.new" "$DIR/app"
install -m 755 "$DIR/app/deploy/streamchat" /usr/local/bin/streamchat

exec /usr/local/bin/streamchat setup
