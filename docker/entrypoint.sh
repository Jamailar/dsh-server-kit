#!/bin/sh
set -eu

umask 077

DSH_HOME=${DSH_HOME:-/data/dsh}
DSH_SERVER_HOME=${DSH_SERVER_HOME:-/data/dsh-server}
WORKSPACE_ROOT=${WORKSPACE_ROOT:-/data/workspace}
DSH_INTERNAL_PORT=${DSH_INTERNAL_PORT:-3080}
STATUS_PORT=${STATUS_PORT:-9000}
DSH_UI_PRESET=${DSH_UI_PRESET:-base}
DSH_SETUP_PROTECTION=${DSH_SETUP_PROTECTION:-open}
DSH_TRUSTED_HOST=${DSH_TRUSTED_HOST:-}
APP_ROOT=${APP_ROOT:-/app}
SEED_ROOT=${SEED_ROOT:-/opt/dsh-seed}
RUNTIME_ROOT=${RUNTIME_ROOT:-/app/runtime}
RUNTIME_CONFIG_PATH=${RUNTIME_CONFIG_PATH:-$DSH_SERVER_HOME/runtime-config.json}
SETUP_CODE_PATH=${SETUP_CODE_PATH:-$DSH_SERVER_HOME/setup-code}
export DSH_HOME DSH_SERVER_HOME WORKSPACE_ROOT DSH_INTERNAL_PORT STATUS_PORT DSH_UI_PRESET DSH_SETUP_PROTECTION DSH_TRUSTED_HOST APP_ROOT SEED_ROOT RUNTIME_ROOT RUNTIME_CONFIG_PATH SETUP_CODE_PATH

fail() {
  printf '%s\n' "dsh-server-kit: $1" >&2
  exit 1
}

require_absolute_path() {
  case "$1" in
    /*) ;;
    *) fail "$2 must be an absolute path" ;;
  esac
}

validate_port() {
  case "$1" in
    ''|*[!0-9]*) fail "$2 must be a decimal TCP port" ;;
  esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || fail "$2 is outside the TCP port range"
}

validate_authority() {
  [ -n "$DSH_TRUSTED_HOST" ] || fail 'trusted host is required after first-time setup'
  node -e '
    const value = process.argv[1]
    if (value.includes(",") || /\s/.test(value) || value.includes("/") || value.includes("@")) process.exit(1)
    let url
    try { url = new URL(`http://${value}`) } catch { process.exit(1) }
    if (url.host !== value || url.pathname !== "/" || url.search !== "" || url.hash !== "") process.exit(1)
  ' "$DSH_TRUSTED_HOST" || fail 'DSH_TRUSTED_HOST must be one host or host:port authority without scheme or path'
}

run_as_dsh() {
  if [ "$(id -u)" -eq 0 ]; then
    setpriv --reuid=dsh --regid=dsh --init-groups "$@"
  else
    "$@"
  fi
}

write_runtime_state() {
  state_name=$1
  state_tmp="$DSH_SERVER_HOME/.runtime-state.$$.tmp"
  printf '{"state":"%s","release":"%s","updatedAt":"%s"}\n' \
    "$state_name" "${DSH_SERVER_RELEASE:-0.1.0}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$state_tmp"
  mv "$state_tmp" "$DSH_SERVER_HOME/runtime-state.json"
}

write_last_known_good() {
  marker_tmp="$DSH_SERVER_HOME/.last-known-good.$$.tmp"
  printf '{"release":"%s","preset":"%s","updatedAt":"%s"}\n' \
    "${DSH_SERVER_RELEASE:-0.1.0}" "$DSH_UI_PRESET" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker_tmp"
  mv "$marker_tmp" "$DSH_SERVER_HOME/last-known-good.json"
}

copy_seed_profile() {
  profile_dir="$DSH_HOME/profiles/web"
  [ -e "$profile_dir" ] && return 0
  seed_dir="$SEED_ROOT/$DSH_UI_PRESET"
  [ -d "$seed_dir" ] || fail "seed preset does not exist: $DSH_UI_PRESET"
  profile_parent="$DSH_HOME/profiles"
  seed_tmp="$profile_parent/.web.$DSH_UI_PRESET.$$.tmp"
  mkdir -p "$profile_parent"
  [ ! -e "$seed_tmp" ] || fail 'unexpected seed staging path exists'
  cp -a "$seed_dir" "$seed_tmp"
  mv "$seed_tmp" "$profile_dir"
}

repair_seed_profile_if_needed() {
  profile_dir="$DSH_HOME/profiles/web"
  seed_dir="$SEED_ROOT/$DSH_UI_PRESET"
  [ -d "$profile_dir" ] || fail 'seed profile is missing after initialization'

  profile_changed=0
  for managed_file in package.json pnpm-lock.yaml cordis.patch.yml pnpm-workspace.yaml server-kit-profile.json; do
    [ -r "$seed_dir/$managed_file" ] || fail "seed profile is missing $managed_file"
    if ! cmp -s "$profile_dir/$managed_file" "$seed_dir/$managed_file"; then
      profile_changed=1
      break
    fi
  done
  for required_package in dsh-auth-gate @deepseek-ai/cordis @deepseek-ai/dsh-invariants @deepseek-ai/dsh-storage; do
    if [ ! -e "$profile_dir/node_modules/$required_package" ]; then
      profile_changed=1
      break
    fi
  done
  [ "$profile_changed" -eq 1 ] || return 0

  [ -d "$seed_dir/node_modules" ] || fail 'seed profile dependencies are missing'
  # A preset switch must replace the managed dependency tree, not merge it:
  # stale Trading/DSH peers would otherwise continue shadowing the new preset.
  staged_deps="$profile_dir/.server-kit-node_modules.$$.tmp"
  previous_deps="$profile_dir/.server-kit-node_modules.$$.previous"
  [ ! -e "$staged_deps" ] && [ ! -e "$previous_deps" ] || fail 'unexpected dependency staging path exists'
  cp -a "$seed_dir/node_modules" "$staged_deps"
  if [ -e "$profile_dir/node_modules" ]; then
    mv "$profile_dir/node_modules" "$previous_deps"
  fi
  if ! mv "$staged_deps" "$profile_dir/node_modules"; then
    [ ! -e "$previous_deps" ] || mv "$previous_deps" "$profile_dir/node_modules"
    fail 'could not activate seed dependencies'
  fi
  # Only the old, distribution-managed dependencies are removed, never user
  # accounts, settings, trading data or workspace files.
  [ ! -e "$previous_deps" ] || rm -rf -- "$previous_deps"
  for managed_file in package.json pnpm-lock.yaml cordis.patch.yml pnpm-workspace.yaml server-kit-profile.json; do
    cp -a "$seed_dir/$managed_file" "$profile_dir/$managed_file"
  done
  printf '%s\n' "{\"event\":\"seed_profile_dependencies_repaired\",\"preset\":\"$DSH_UI_PRESET\"}"
}

brand_auth_gate_login() {
  run_as_dsh node "$APP_ROOT/scripts/brand-auth-gate-login.mjs" --profile "$DSH_HOME/profiles/web"
}

seed_admin_if_needed() {
  users_file="$DSH_HOME/auth/users.yaml"
  [ -s "$users_file" ] && return 0
  [ -n "${DSH_ADMIN_USERNAME:-}" ] || fail 'DSH_ADMIN_USERNAME is required when no auth user exists'
  [ -n "${DSH_ADMIN_PASSWORD:-}" ] || fail 'DSH_ADMIN_PASSWORD is required when no auth user exists'
  auth_cli="$DSH_HOME/profiles/web/node_modules/dsh-auth-gate/lib/cli.js"
  [ -r "$auth_cli" ] || fail 'seed profile has no dsh-auth-gate CLI'
  mkdir -p "$DSH_HOME/auth"
  printf '%s\n' "$DSH_ADMIN_PASSWORD" | run_as_dsh node "$auth_cli" user add "$DSH_ADMIN_USERNAME" --password-stdin
  unset DSH_ADMIN_PASSWORD
  unset DSH_ADMIN_USERNAME
}

read_configured_host() {
  [ -s "$RUNTIME_CONFIG_PATH" ] || return 1
  node -e '
    const config = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    if (config.schemaVersion !== 1 || typeof config.trustedHost !== "string") process.exit(1)
    process.stdout.write(config.trustedHost)
  ' "$RUNTIME_CONFIG_PATH"
}

persist_trusted_host() {
  run_as_dsh node -e '
    const fs = require("node:fs")
    const path = require("node:path")
    const [configPath, trustedHost] = process.argv.slice(1)
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 })
    const temporary = `${configPath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, trustedHost, configuredAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" })
    fs.renameSync(temporary, configPath)
  ' "$RUNTIME_CONFIG_PATH" "$DSH_TRUSTED_HOST"
}

run_initial_setup() {
  run_as_dsh env \
    SETUP_HOST=0.0.0.0 \
    SETUP_PORT=8080 \
    DSH_SETUP_PROTECTION="$DSH_SETUP_PROTECTION" \
    RUNTIME_CONFIG_PATH="$RUNTIME_CONFIG_PATH" \
    SETUP_CODE_PATH="$SETUP_CODE_PATH" \
    AUTH_GATE_CLI="$DSH_HOME/profiles/web/node_modules/dsh-auth-gate/lib/cli.js" \
    node "$APP_ROOT/src/setup-server.mjs" &
  BOOTSTRAP_PID=$!
  while [ ! -s "$RUNTIME_CONFIG_PATH" ]; do
    kill -0 "$BOOTSTRAP_PID" 2>/dev/null || fail 'initial setup server stopped before configuration completed'
    sleep 1
  done
  # Give the successful setup response time to reach the browser before the
  # temporary listener is stopped and Caddy takes over the same port.
  sleep 1
  kill "$BOOTSTRAP_PID" 2>/dev/null || true
  wait "$BOOTSTRAP_PID" 2>/dev/null || true
  unset BOOTSTRAP_PID
}

resolve_trusted_host() {
  persisted_host=''
  if [ -s "$RUNTIME_CONFIG_PATH" ]; then
    persisted_host=$(read_configured_host) || fail 'persisted runtime configuration is invalid'
  fi

  if [ -n "$DSH_TRUSTED_HOST" ] && [ -n "$persisted_host" ] && [ "$DSH_TRUSTED_HOST" != "$persisted_host" ]; then
    fail 'DSH_TRUSTED_HOST differs from the persisted runtime configuration'
  fi

  if [ -z "$DSH_TRUSTED_HOST" ] && [ -n "$persisted_host" ]; then
    DSH_TRUSTED_HOST=$persisted_host
  fi

  if [ -z "$DSH_TRUSTED_HOST" ]; then
    [ ! -s "$DSH_HOME/auth/users.yaml" ] || fail 'runtime configuration is missing for an existing installation; set DSH_TRUSTED_HOST once to migrate it'
    run_initial_setup
    DSH_TRUSTED_HOST=$(read_configured_host) || fail 'initial setup did not write a valid runtime configuration'
  fi
  validate_authority
  if [ ! -s "$RUNTIME_CONFIG_PATH" ]; then
    persist_trusted_host || fail 'could not persist runtime configuration'
  fi
  export DSH_TRUSTED_HOST
}

stop_services() {
  trap - TERM INT EXIT
  write_runtime_state stopping || true
  [ -n "${BOOTSTRAP_PID:-}" ] && kill "$BOOTSTRAP_PID" 2>/dev/null || true
  [ -n "${CADDY_PID:-}" ] && kill "$CADDY_PID" 2>/dev/null || true
  [ -n "${DSH_PID:-}" ] && kill "$DSH_PID" 2>/dev/null || true
  [ -n "${STATUS_PID:-}" ] && kill "$STATUS_PID" 2>/dev/null || true
  [ -n "${BOOTSTRAP_PID:-}" ] && wait "$BOOTSTRAP_PID" 2>/dev/null || true
  [ -n "${CADDY_PID:-}" ] && wait "$CADDY_PID" 2>/dev/null || true
  [ -n "${DSH_PID:-}" ] && wait "$DSH_PID" 2>/dev/null || true
  [ -n "${STATUS_PID:-}" ] && wait "$STATUS_PID" 2>/dev/null || true
}

require_absolute_path "$DSH_HOME" DSH_HOME
require_absolute_path "$DSH_SERVER_HOME" DSH_SERVER_HOME
require_absolute_path "$WORKSPACE_ROOT" WORKSPACE_ROOT
validate_port "$DSH_INTERNAL_PORT" DSH_INTERNAL_PORT
validate_port "$STATUS_PORT" STATUS_PORT
case "$DSH_UI_PRESET" in base|workbench|trading) ;; *) fail 'DSH_UI_PRESET must be base, workbench or trading' ;; esac
case "$DSH_SETUP_PROTECTION" in open|code) ;; *) fail 'DSH_SETUP_PROTECTION must be open or code' ;; esac

mkdir -p "$DSH_HOME" "$DSH_SERVER_HOME" "$WORKSPACE_ROOT"
if [ "$(id -u)" -eq 0 ]; then
  chown dsh:dsh "$DSH_HOME" "$DSH_SERVER_HOME" "$WORKSPACE_ROOT"
  chmod 0700 "$DSH_HOME" "$DSH_SERVER_HOME"
fi
[ -w "$DSH_HOME" ] && [ -w "$DSH_SERVER_HOME" ] && [ -w "$WORKSPACE_ROOT" ] || fail 'persistent paths must be writable by the dsh runtime user'

# `setpriv` changes the process uid but deliberately keeps its environment.
# Give DSH a real, writable home so browser-side directory selection starts in
# the persistent workspace instead of the image user's inaccessible `/root`.
HOME=$WORKSPACE_ROOT
XDG_CONFIG_HOME=$DSH_SERVER_HOME/xdg-config
XDG_DATA_HOME=$DSH_SERVER_HOME/xdg-data
export HOME XDG_CONFIG_HOME XDG_DATA_HOME
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
if [ "$(id -u)" -eq 0 ]; then
  chown dsh:dsh "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
fi

copy_seed_profile
repair_seed_profile_if_needed
if [ "$(id -u)" -eq 0 ]; then
  chown -R dsh:dsh "$DSH_HOME/profiles" "$DSH_HOME/auth" 2>/dev/null || chown -R dsh:dsh "$DSH_HOME/profiles"
fi
brand_auth_gate_login

DSH_SERVER_RELEASE=$(node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).release.version)' "$APP_ROOT/config/release-manifest.json")
export DSH_SERVER_RELEASE
trap stop_services TERM INT EXIT
resolve_trusted_host
run_as_dsh node "$APP_ROOT/scripts/preflight-upgrade.mjs" --home "$DSH_HOME" --preset "$DSH_UI_PRESET"
seed_admin_if_needed

write_runtime_state starting
cd "$WORKSPACE_ROOT"

run_as_dsh "$RUNTIME_ROOT/node_modules/.bin/dsh" web \
  --host 127.0.0.1 \
  --port "$DSH_INTERNAL_PORT" \
  --no-open \
  --trusted-host "$DSH_TRUSTED_HOST" &
DSH_PID=$!

run_as_dsh node "$APP_ROOT/scripts/probe-auth-gate.mjs" \
  --port "$DSH_INTERNAL_PORT" \
  --trusted-host "$DSH_TRUSTED_HOST" \
  --wait-ms 60000

run_as_dsh env \
  STATUS_PORT="$STATUS_PORT" \
  DSH_INTERNAL_PORT="$DSH_INTERNAL_PORT" \
  DSH_TRUSTED_HOST="$DSH_TRUSTED_HOST" \
  RUNTIME_STATE_PATH="$DSH_SERVER_HOME/runtime-state.json" \
  RELEASE_MANIFEST_PATH="$APP_ROOT/config/release-manifest.json" \
  node "$APP_ROOT/src/status-server.mjs" &
STATUS_PID=$!

run_as_dsh caddy run --config "$APP_ROOT/config/Caddyfile" --adapter caddyfile &
CADDY_PID=$!

write_runtime_state ready
write_last_known_good

while kill -0 "$DSH_PID" 2>/dev/null && kill -0 "$CADDY_PID" 2>/dev/null && kill -0 "$STATUS_PID" 2>/dev/null; do
  sleep 2
done

fail 'a required service stopped'
