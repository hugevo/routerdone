#!/usr/bin/env bash
# RouterDone one-line installer.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/thoa100m/routerdone/main/install.sh | bash
#
# Optional env:
#   PORT=20128          host port (default 20128)
#   DIR=routerdone      install directory (default routerdone)
#   INITIAL_PASSWORD=... admin password (default: auto-generated, printed at end)
set -euo pipefail

REPO="https://github.com/thoa100m/routerdone.git"
DIR="${DIR:-routerdone}"
PORT="${PORT:-20128}"

say() { printf "\033[36m[routerdone]\033[0m %s\n" "$1"; }
die() { printf "\033[31m[routerdone] %s\033[0m\n" "$1" >&2; exit 1; }

command -v git >/dev/null 2>&1 || die "git is required."
command -v docker >/dev/null 2>&1 || die "docker is required (install: curl -fsSL https://get.docker.com | sh)."
docker compose version >/dev/null 2>&1 || die "docker compose v2 is required."

rand() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

if [ -d "$DIR/.git" ]; then
  say "Updating existing clone in $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  say "Generating .env with fresh secrets"
  ADMIN_PW="${INITIAL_PASSWORD:-$(rand | cut -c1-24)}"
  cat > .env <<EOF
JWT_SECRET=$(rand)
INITIAL_PASSWORD=${ADMIN_PW}
API_KEY_SECRET=$(rand)
MACHINE_ID_SALT=$(rand)
PORT=${PORT}
NODE_ENV=production
TZ=UTC
DATA_DIR=/app/data
BASE_URL=http://localhost:${PORT}
NEXT_PUBLIC_BASE_URL=http://localhost:${PORT}
AUTH_COOKIE_SECURE=false
REQUIRE_API_KEY=false
ENABLE_REQUEST_LOGS=false
OBSERVABILITY_ENABLED=true
EOF
  PRINT_PW=1
else
  say ".env already exists, keeping it"
  PRINT_PW=0
fi

say "Building and starting (first run may take a few minutes)"
PORT="${PORT}" docker compose up --build -d

say "Waiting for health..."
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${PORT}/api/health" >/dev/null 2>&1; then
    say "RouterDone is up at http://localhost:${PORT}"
    if [ "$PRINT_PW" = "1" ]; then
      say "Admin password: $(grep '^INITIAL_PASSWORD=' .env | cut -d= -f2-)"
    fi
    exit 0
  fi
  sleep 3
done
die "Health check timed out. Inspect logs: docker compose logs -f"
