import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const dockerfile = await readFile(resolve(root, 'Dockerfile'), 'utf8')
const entrypoint = await readFile(resolve(root, 'docker/entrypoint.sh'), 'utf8')
const caddyfile = await readFile(resolve(root, 'config/Caddyfile'), 'utf8')

const required = [
  ['pinned node image', /node:24\.14\.0-bookworm-slim@sha256:/],
  ['pinned Caddy image', /caddy:2\.10\.2-alpine@sha256:/],
  ['non-root service switch', /setpriv --reuid=dsh --regid=dsh --init-groups/],
  ['loopback DSH bind', /--host 127\.0\.0\.1/],
  ['DSH trusted host', /--trusted-host "\$DSH_TRUSTED_HOST"/],
  ['auth gate probe', /probe-auth-gate\.mjs/],
  ['Caddy public host preservation', /header_up Host \{http\.request\.host\}/],
  ['no published DSH port', /EXPOSE 8080/],
]

for (const [name, expression] of required) {
  const target = name.startsWith('Caddy') ? caddyfile : name.startsWith('pinned') || name === 'no published DSH port' ? dockerfile : entrypoint
  if (!expression.test(target)) throw new Error(`contract missing: ${name}`)
}

process.stdout.write('static container contract verified\n')
