import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { spawn } from 'node:child_process'
import { probeAuthGate } from '../../src/dsh-probe.mjs'

const projectRoot = new URL('../..', import.meta.url)

function onceListening(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
}

function request(port, path) {
  return fetch(`http://127.0.0.1:${port}${path}`).then(async (response) => ({ status: response.status, body: await response.json() }))
}

test('auth readiness probe requires a mounted public status endpoint and a denied protected request', async () => {
  const upstream = createServer((req, res) => {
    if (req.url === '/auth/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ authenticated: false }))
      return
    }
    res.writeHead(401)
    res.end('unauthorized')
  })
  await onceListening(upstream)
  after(() => upstream.close())
  const port = upstream.address().port
  assert.equal(await probeAuthGate({ port, trustedHost: 'dsh.example.com' }), true)
})

test('status server keeps health public and does not claim readiness when DSH is absent', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-server-kit-state-'))
  const statePath = join(stateDir, 'runtime-state.json')
  await writeFile(statePath, JSON.stringify({ state: 'ready' }))
  const holder = createServer()
  await onceListening(holder)
  const statusPort = holder.address().port
  await new Promise((resolve) => holder.close(resolve))

  const child = spawn(process.execPath, ['src/status-server.mjs'], {
    cwd: new URL('.', projectRoot),
    env: {
      ...process.env,
      STATUS_PORT: String(statusPort),
      DSH_INTERNAL_PORT: '65531',
      DSH_TRUSTED_HOST: 'dsh.example.com',
      RUNTIME_STATE_PATH: statePath,
      RELEASE_MANIFEST_PATH: new URL('config/release-manifest.json', projectRoot).pathname,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  after(() => child.kill('SIGTERM'))
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
  })

  assert.deepEqual(await request(statusPort, '/healthz'), { status: 200, body: { status: 'ok' } })
  assert.deepEqual(await request(statusPort, '/readyz'), { status: 503, body: { status: 'starting' } })
  const version = await request(statusPort, '/versionz')
  assert.equal(version.status, 200)
  assert.equal(version.body.release, '0.1.0')
  assert.equal('path' in version.body, false)
})

test('release manifest, seed locks, and Caddy trust boundary are internally consistent', async () => {
  const manifest = JSON.parse(await readFile(new URL('config/release-manifest.json', projectRoot), 'utf8'))
  assert.equal(manifest.runtime.dsh.version, '0.1.2-rc.1')
  assert.equal(manifest.runtime.authGate.version, '0.12.0')
  assert.equal(manifest.presets.base.packages['dsh-auth-gate'], manifest.runtime.authGate.version)
  assert.equal(manifest.presets.workbench.packages['dsh-better-sidebar'], manifest.runtime.betterSidebar.version)

  const caddyfile = await readFile(new URL('config/Caddyfile', projectRoot), 'utf8')
  assert.match(caddyfile, /header_up Host \{http\.request\.host\}/)
  assert.match(caddyfile, /header_up -X-Dsh-Proxy/)
  assert.doesNotMatch(caddyfile, /header_up Host 127\.0\.0\.1/)
})
