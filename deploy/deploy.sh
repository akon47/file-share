#!/usr/bin/env bash
# Runs ON the file-share VM (invoked by Jenkins over ssh, or by an operator):
#   APP_TAG=12 ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

export APP_TAG="${APP_TAG:-latest}"
# The container runs as uid 1000 (node) with a read-only root; ./data must be writable for signing.key.
mkdir -p data
chown 1000:1000 data 2>/dev/null || sudo chown 1000:1000 data
# Remember the deployed tag so later manual `docker compose ps/logs` use the same image, not a stale :latest.
echo "APP_TAG=${APP_TAG}" > .env

echo "[deploy] akon47/file-share:${APP_TAG}"
docker compose pull --quiet
docker compose up -d --remove-orphans --wait --wait-timeout 90
docker image prune -f >/dev/null 2>&1 || true
docker compose ps
