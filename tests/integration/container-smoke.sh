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
  "$image_tag" >/dev/null

for _ in $(seq 1 90); do
  if curl --silent --fail --output /dev/null "http://127.0.0.1:${host_port}/healthz"; then
    break
  fi
  sleep 2
done

setup_code=''
for _ in $(seq 1 30); do
  setup_code=$(docker logs "$container_name" 2>&1 | sed -n -E 's/.*"setupCode":"([^"]+)".*/\1/p' | head -n 1)
  [ -n "$setup_code" ] && break
  sleep 1
done
test -n "$setup_code"

curl --silent --show-error --fail \
  -H "Host: localhost:${host_port}" \
  --data-urlencode "trustedHost=localhost:${host_port}" \
  --data-urlencode 'username=admin' \
  --data-urlencode 'password=ci-only-not-a-production-secret' \
  --data-urlencode 'passwordConfirm=ci-only-not-a-production-secret' \
  --data-urlencode "setupCode=${setup_code}" \
  --output /dev/null \
  "http://127.0.0.1:${host_port}/setup"

for _ in $(seq 1 90); do
  if curl --silent --fail --output /dev/null -H "Host: localhost:${host_port}" "http://127.0.0.1:${host_port}/readyz"; then
    break
  fi
  sleep 2
done

curl --silent --fail -H "Host: localhost:${host_port}" "http://127.0.0.1:${host_port}/readyz" | grep -F '"ready"'
test "$(curl --silent --output /dev/null --write-out '%{http_code}' -H "Host: localhost:${host_port}" -H 'Accept: application/json' "http://127.0.0.1:${host_port}/")" = "401"
curl --silent --fail -H "Host: localhost:${host_port}" "http://127.0.0.1:${host_port}/auth/status" | grep -F '"authenticated":false'
