import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
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

function pause(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function availablePort() {
  const holder = createServer()
  await onceListening(holder)
  const port = holder.address().port
  await new Promise((resolve) => holder.close(resolve))
  return port
}

async function waitForHttp(port, path, expectedStatus) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      if (response.status === expectedStatus) return response
    } catch {
      // The bootstrap listener has not bound its socket yet.
    }
    await pause(25)
  }
  throw new Error(`timed out waiting for ${path}`)
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

test('first-open setup persists only public runtime configuration and delegates user creation to Auth Gate', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-server-kit-setup-'))
  const dshHome = join(stateDir, 'dsh')
  const configPath = join(stateDir, 'runtime-config.json')
  const setupCodePath = join(stateDir, 'setup-code')
  const authCli = join(stateDir, 'fake-auth-cli.mjs')
  const port = await availablePort()

  await mkdir(dshHome, { recursive: true })
  await writeFile(authCli, `
    import { mkdir, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    let password = ''
    for await (const chunk of process.stdin) password += chunk
    if (process.argv[2] !== 'user' || process.argv[3] !== 'add' || password.trim() === '') process.exit(1)
    await mkdir(join(process.env.DSH_HOME, 'auth'), { recursive: true })
    await writeFile(join(process.env.DSH_HOME, 'auth', 'users.yaml'), 'user: ' + process.argv[4] + '\\nhash: delegated-by-auth-gate\\n')
  `)

  const child = spawn(process.execPath, ['src/setup-server.mjs'], {
    cwd: new URL('.', projectRoot),
    env: {
      ...process.env,
      SETUP_HOST: '127.0.0.1',
      SETUP_PORT: String(port),
      DSH_HOME: dshHome,
      RUNTIME_CONFIG_PATH: configPath,
      SETUP_CODE_PATH: setupCodePath,
      AUTH_GATE_CLI: authCli,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(() => child.kill('SIGTERM'))

  assert.equal((await waitForHttp(port, '/healthz', 200)).status, 200)
  assert.equal((await request(port, '/readyz')).status, 503)
  const setupCode = (await readFile(setupCodePath, 'utf8')).trim()
  const body = new URLSearchParams({
    trustedHost: 'dsh.example.com',
    username: 'admin',
    password: 'a-long-test-password',
    passwordConfirm: 'a-long-test-password',
    setupCode,
  })
  const response = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  assert.equal(response.status, 202)

  const runtimeConfig = JSON.parse(await readFile(configPath, 'utf8'))
  assert.deepEqual(Object.keys(runtimeConfig).sort(), ['configuredAt', 'schemaVersion', 'trustedHost'])
  assert.equal(runtimeConfig.trustedHost, 'dsh.example.com')
  assert.match(await readFile(join(dshHome, 'auth', 'users.yaml'), 'utf8'), /user: admin/)
  await assert.rejects(unlink(setupCodePath), { code: 'ENOENT' })
})

test('release manifest, seed locks, and Caddy trust boundary are internally consistent', async () => {
  const manifest = JSON.parse(await readFile(new URL('config/release-manifest.json', projectRoot), 'utf8'))
  assert.equal(manifest.runtime.dsh.version, '0.1.2-rc.1')
  assert.equal(manifest.runtime.authGate.version, '0.12.0')
  assert.equal(manifest.presets.base.packages['dsh-auth-gate'], manifest.runtime.authGate.version)
  assert.equal(manifest.presets.workbench.packages['dsh-better-sidebar'], manifest.runtime.betterSidebar.version)

  const caddyfile = await readFile(new URL('config/Caddyfile', projectRoot), 'utf8')
  assert.match(caddyfile, /@invalid_host not host \{\$DSH_TRUSTED_HOST\}/)
  assert.match(caddyfile, /header_up Host \{http\.request\.host\}/)
  assert.match(caddyfile, /header_up -X-Dsh-Proxy/)
  assert.doesNotMatch(caddyfile, /header_up Host 127\.0\.0\.1/)

  const setupServer = await readFile(new URL('src/setup-server.mjs', projectRoot), 'utf8')
  assert.match(setupServer, /timingSafeEqual/)
  assert.match(setupServer, /password-stdin/)
  assert.match(setupServer, /initial_setup_required/)
})
