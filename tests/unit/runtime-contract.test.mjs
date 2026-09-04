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

async function createFakeAuthCli(stateDir) {
  const authCli = join(stateDir, 'fake-auth-cli.mjs')
  await writeFile(authCli, `
    import { mkdir, writeFile } from 'node:fs/promises'
    import { join } from 'node:path'
    let password = ''
    for await (const chunk of process.stdin) password += chunk
    if (process.argv[2] !== 'user' || process.argv[3] !== 'add' || password.trim() === '') process.exit(1)
    await mkdir(join(process.env.DSH_HOME, 'auth'), { recursive: true })
    await writeFile(join(process.env.DSH_HOME, 'auth', 'users.yaml'), 'user: ' + process.argv[4] + '\\nhash: delegated-by-auth-gate\\n')
  `)
  return authCli
}

async function createExistingUserAuthGate(stateDir) {
  const packageRoot = join(stateDir, 'existing-auth-gate')
  const authCli = join(packageRoot, 'lib', 'cli.js')
  await mkdir(join(packageRoot, 'lib', 'shared'), { recursive: true })
  await mkdir(join(packageRoot, 'lib', 'features', 'password'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(authCli, "process.stderr.write(`user ${process.argv[4]} already exists\\n`)\nprocess.exitCode = 1\n")
  await writeFile(join(packageRoot, 'lib', 'shared', 'users-file.js'), `
    export async function loadUsersFile() {
      return { snapshot: { users: new Map([['admin', { passwordHash: 'fixture-hash' }]]) } }
    }
  `)
  await writeFile(join(packageRoot, 'lib', 'features', 'password', 'password.js'), `
    export async function verifyPassword(password, passwordHash) {
      return password === 'a-long-test-password' && passwordHash === 'fixture-hash'
    }
  `)
  return { authCli, packageRoot }
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

test('code-protected first-open setup persists only public runtime configuration and delegates user creation to Auth Gate', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-server-kit-setup-'))
  const dshHome = join(stateDir, 'dsh')
  const configPath = join(stateDir, 'runtime-config.json')
  const setupCodePath = join(stateDir, 'setup-code')
  const authCli = await createFakeAuthCli(stateDir)
  const port = await availablePort()

  await mkdir(dshHome, { recursive: true })
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
      DSH_SETUP_PROTECTION: 'code',
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

test('default first-open setup rejects an email username before Auth Gate is called', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-server-kit-open-setup-'))
  const dshHome = join(stateDir, 'dsh')
  const configPath = join(stateDir, 'runtime-config.json')
  const setupCodePath = join(stateDir, 'setup-code')
  const authCli = await createFakeAuthCli(stateDir)
  const port = await availablePort()

  await mkdir(dshHome, { recursive: true })
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

  const setupPage = await waitForHttp(port, '/setup', 200)
  const setupHtml = await setupPage.text()
  assert.doesNotMatch(setupHtml, /name="setupCode"/)
  assert.match(setupHtml, /不支持邮箱/)
  assert.match(setupHtml, /DeepSeek Harness/)
  assert.match(setupHtml, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/)
  assert.match(setupHtml, /id="setup-form"/)
  assert.match(setupHtml, /<label for="username">管理员用户名<\/label>/)
  assert.match(setupHtml, /field-shake/)
  assert.match(setupHtml, /new URLSearchParams\(new FormData\(form\)\)/)
  assert.match(setupHtml, /fetch\('\/readyz'/)
  assert.match(setupHtml, /\/auth\/login\?next=%2F/)
  assert.doesNotMatch(setupHtml, /window\.location\.reload\(\)/)
  assert.match(setupPage.headers.get('content-security-policy') ?? '', /img-src 'self'/)
  assert.match(setupPage.headers.get('content-security-policy') ?? '', /script-src 'unsafe-inline'/)
  const favicon = await fetch(`http://127.0.0.1:${port}/favicon.svg`)
  assert.equal(favicon.status, 200)
  assert.equal(favicon.headers.get('content-type'), 'image/svg+xml')
  assert.match(await favicon.text(), /prefers-color-scheme: dark/)
  await assert.rejects(readFile(setupCodePath, 'utf8'), { code: 'ENOENT' })

  const body = new URLSearchParams({
    trustedHost: 'dsh.example.com',
    username: 'admin@example.com',
    password: 'a-long-test-password',
    passwordConfirm: 'a-long-test-password',
  })
  const response = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  assert.equal(response.status, 400)
  assert.match(await response.text(), /管理员用户名格式无效/)
  await assert.rejects(readFile(configPath, 'utf8'), { code: 'ENOENT' })

  const jsonResponse = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  assert.equal(jsonResponse.status, 400)
  assert.deepEqual(await jsonResponse.json(), { error: '管理员用户名格式无效。' })
})

test('setup safely resumes after an existing administrator was created before runtime configuration was saved', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-server-kit-resume-setup-'))
  const dshHome = join(stateDir, 'dsh')
  const configPath = join(stateDir, 'runtime-config.json')
  const { authCli, packageRoot } = await createExistingUserAuthGate(stateDir)
  const port = await availablePort()
  let stderr = ''

  await mkdir(dshHome, { recursive: true })
  const child = spawn(process.execPath, ['src/setup-server.mjs'], {
    cwd: new URL('.', projectRoot),
    env: {
      ...process.env,
      SETUP_HOST: '127.0.0.1',
      SETUP_PORT: String(port),
      DSH_HOME: dshHome,
      RUNTIME_CONFIG_PATH: configPath,
      AUTH_GATE_CLI: authCli,
      AUTH_GATE_PACKAGE_ROOT: packageRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  t.after(() => child.kill('SIGTERM'))

  await waitForHttp(port, '/setup', 200)
  const wrongPassword = new URLSearchParams({
    trustedHost: 'dsh.example.com',
    username: 'admin',
    password: 'a-different-password',
    passwordConfirm: 'a-different-password',
  })
  const denied = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: wrongPassword,
  })
  assert.equal(denied.status, 400)
  assert.deepEqual(await denied.json(), { error: '管理员用户名已存在，但密码不匹配。请使用此前设置的密码继续初始化。' })
  await assert.rejects(readFile(configPath, 'utf8'), { code: 'ENOENT' })

  const validPassword = new URLSearchParams({
    trustedHost: 'dsh.example.com',
    username: 'admin',
    password: 'a-long-test-password',
    passwordConfirm: 'a-long-test-password',
  })
  const response = await fetch(`http://127.0.0.1:${port}/setup`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: validPassword,
  })
  assert.equal(response.status, 202)
  assert.deepEqual(await response.json(), { status: 'initializing' })
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).trustedHost, 'dsh.example.com')
  assert.match(stderr, /"event":"setup_existing_admin_password_mismatch","username":"admin"/)
  assert.match(stderr, /"event":"setup_existing_admin_verified","username":"admin"/)
  assert.doesNotMatch(stderr, /a-long-test-password/)
  assert.doesNotMatch(stderr, /a-different-password/)
})

test('Auth Gate branding patch adds the DeepSeek title and mark without touching its authentication flow', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'dsh-server-kit-branding-'))
  const packageDir = join(stateDir, 'node_modules', 'dsh-auth-gate')
  const loginPage = join(packageDir, 'lib', 'shared', 'login-page.js')
  await mkdir(join(packageDir, 'lib', 'shared'), { recursive: true })
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: 'dsh-auth-gate', version: '0.12.0' }))
  await writeFile(loginPage, [
    'const CARD_STYLE = `old`;',
    "const SHIELD_SVG = '<svg></svg>';",
    'const page = `<!doctype html>',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>${options.title}</title>',
    '<style>${CARD_STYLE}</style>',
    '<div class="brand">${SHIELD_SVG}</div>`;',
    '<form method="post" action="/auth/login"></form>',
    '//# sourceMappingURL=login-page.js.map',
    '',
  ].join('\n'))

  async function applyBranding() {
    const child = spawn(process.execPath, ['scripts/brand-auth-gate-login.mjs', '--profile', stateDir], {
      cwd: new URL('.', projectRoot),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const completed = new Promise((resolve, reject) => child.once('exit', resolve).once('error', reject))
    let stderr = ''
    for await (const chunk of child.stderr) stderr += chunk
    const exitCode = await completed
    assert.equal(exitCode, 0, stderr)
  }

  await applyBranding()
  const branded = await readFile(loginPage, 'utf8')
  assert.match(branded, /dsh-server-kit-deepseek-brand-v1/)
  assert.match(branded, /DeepSeek Harness/)
  assert.match(branded, /src="\/favicon\.svg"/)
  assert.match(branded, /<form method="post" action="\/auth\/login"><\/form>/)
  assert.doesNotMatch(branded, /sourceMappingURL/)
  await applyBranding()
  assert.equal(await readFile(loginPage, 'utf8'), branded)
})

test('release manifest, seed locks, and Caddy trust boundary are internally consistent', async () => {
  const manifest = JSON.parse(await readFile(new URL('config/release-manifest.json', projectRoot), 'utf8'))
  assert.equal(manifest.runtime.dsh.version, '0.1.2-rc.1')
  assert.equal(manifest.runtime.authGate.version, '0.12.0')
  assert.equal(manifest.presets.base.packages['dsh-auth-gate'], manifest.runtime.authGate.version)
  assert.equal(manifest.presets.base.packages['@deepseek-ai/cordis'], '4.0.2')
  assert.equal(manifest.presets.base.packages['@deepseek-ai/dsh-invariants'], '0.1.0-rc.8')
  assert.equal(manifest.presets.base.packages['@deepseek-ai/dsh-storage'], '0.1.0-rc.8')
  assert.equal(manifest.presets.workbench.packages['dsh-better-sidebar'], manifest.runtime.betterSidebar.version)

  const caddyfile = await readFile(new URL('config/Caddyfile', projectRoot), 'utf8')
  assert.match(caddyfile, /@invalid_host not host \{\$DSH_TRUSTED_HOST\}/)
  assert.match(caddyfile, /header_up Host \{http\.request\.host\}/)
  assert.match(caddyfile, /header_up -X-Dsh-Proxy/)
  assert.doesNotMatch(caddyfile, /header_up Host 127\.0\.0\.1/)
  assert.match(caddyfile, /handle \/favicon\.svg/)
  assert.match(caddyfile, /versions 1\.1/)
  assert.doesNotMatch(caddyfile, /versions h1/)

  const setupServer = await readFile(new URL('src/setup-server.mjs', projectRoot), 'utf8')
  assert.match(setupServer, /timingSafeEqual/)
  assert.match(setupServer, /password-stdin/)
  assert.match(setupServer, /DSH_SETUP_PROTECTION/)
  assert.match(setupServer, /initial_setup_required/)

  const dockerfile = await readFile(new URL('Dockerfile', projectRoot), 'utf8')
  assert.match(dockerfile, /dsh-auth-gate\/lib\/cli\.js user add build-smoke --password-stdin/)
  const entrypoint = await readFile(new URL('docker/entrypoint.sh', projectRoot), 'utf8')
  assert.match(entrypoint, /repair_seed_profile_if_needed/)
  assert.match(entrypoint, /seed_profile_dependencies_repaired/)
  assert.match(entrypoint, /--no-open/)
})
