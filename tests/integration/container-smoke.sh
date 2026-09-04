#!/usr/bin/env bash
set -euo pipefail

image_tag="dsh-server-kit:ci-${GITHUB_RUN_ID:-local}"
container_name="dsh-server-kit-smoke-${GITHUB_RUN_ID:-local}"
host_port="18080"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build --pull=false --tag "$image_tag" .
docker run --detach --name "$container_name" \
  --publish "127.0.0.1:${host_port}:8080" \
  --env DSH_TRUSTED_HOST="localhost:${host_port}" \
  --env DSH_ADMIN_USERNAME=admin \
  --env DSH_ADMIN_PASSWORD='ci-only-not-a-production-secret' \
  "$image_tag" >/dev/null

for _ in $(seq 1 90); do
  if curl --silent --fail --output /dev/null "http://127.0.0.1:${host_port}/readyz"; then
    break
  fi
  sleep 2
done

curl --silent --fail "http://127.0.0.1:${host_port}/readyz" | grep -F '"ready"'
test "$(curl --silent --output /dev/null --write-out '%{http_code}' -H 'Accept: application/json' "http://127.0.0.1:${host_port}/")" = "401"
curl --silent --fail "http://127.0.0.1:${host_port}/auth/status" | grep -F '"authenticated":false'
