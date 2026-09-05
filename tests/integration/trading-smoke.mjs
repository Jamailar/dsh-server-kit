import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Runs real locked DSH + Trading without contacting a broker or placing orders.
// Optional arguments let the Docker smoke exercise the built image artifacts.
const seed = resolve(process.argv[2] ?? 'seed-profiles/trading')
const runtime = resolve(process.argv[3] ?? 'runtime')
const scratch = await mkdtemp(join(os.tmpdir(), 'dsh-trading-smoke-'))
const workspace = join(scratch, 'workspace')
const dshHome = join(scratch, 'dsh')
const profile = join(dshHome, 'profiles', 'web')
const env = { ...process.env, HOME: workspace, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: '1' }
const password = 'test-only-trading-password'
const listener = net.createServer()
listener.listen(0, '127.0.0.1')
await once(listener, 'listening')
const port = listener.address().port
await new Promise((done) => listener.close(done))
const authority = `trading.example.test:${port}`
const base = `http://127.0.0.1:${port}`
let child
let output = ''
let cookies = new Map()

async function request(path, { authenticated = false, ...options } = {}) {
  // Node fetch may rewrite Host to the loopback URL; use the same public
  // authority-preserving HTTP hop as Caddy instead.
  const res = await new Promise((done, reject) => {
    const req = http.request(`${base}${path}`, {
      method: options.method ?? 'GET',
      headers: {
        Host: authority,
        Accept: 'application/json',
        ...(authenticated ? { Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        ...(options.body instanceof URLSearchParams ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...options.headers,
      },
    }, (incoming) => {
      const chunks = []
      incoming.on('data', (chunk) => chunks.push(chunk))
      incoming.on('end', () => {
        const headers = new Headers()
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1])
        done(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }))
      })
      incoming.on('error', reject)
    })
    req.setTimeout(5000, () => req.destroy(new Error('request timed out')))
    req.on('error', reject)
    req.end(options.body?.toString())
  })
  if (authenticated) for (const cookie of res.headers.getSetCookie()) {
    const pair = cookie.split(';')[0]
    const index = pair.indexOf('=')
    cookies.set(pair.slice(0, index), pair.slice(index + 1))
  }
  return res
}

async function start() {
  child = spawn(process.execPath, [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open', '--trusted-host', authority], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error('DSH exited before readiness')
    const res = await request('/auth/status').catch(() => undefined)
    if (res?.status === 200 && (await request('/')).status === 401) return
    await new Promise((done) => setTimeout(done, 250))
  }
  throw new Error('DSH readiness timed out')
}

async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timer)
}

async function login() {
  cookies = new Map()
  const res = await request('/auth/login', {
    authenticated: true,
    method: 'POST',
    body: new URLSearchParams({ username: 'smoke-admin', password, next: '/' }),
  })
  assert.equal(res.status, 302, 'password login must succeed')
  assert(res.headers.getSetCookie().some((cookie) => /;\s*Secure/i.test(cookie)), 'auth cookie must stay Secure')
  const location = res.headers.get('location')
  assert(location?.startsWith('/?token='), 'login must bridge to DSH browser session')
  await request(location, { authenticated: true })
  assert.equal((await (await request('/auth/status', { authenticated: true })).json()).authenticated, true)
}

try {
  await mkdir(profile, { recursive: true })
  await mkdir(workspace, { recursive: true })
  for (const file of ['package.json', 'cordis.patch.yml', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) await cp(join(seed, file), join(profile, file))
  await symlink(join(seed, 'node_modules'), join(profile, 'node_modules'), 'dir')
  const added = spawnSync(process.execPath, [join(seed, 'node_modules/dsh-auth-gate/lib/cli.js'), 'user', 'add', 'smoke-admin', '--password-stdin'], { env, input: `${password}\n`, encoding: 'utf8' })
  assert.equal(added.status, 0, 'Auth Gate must create an administrator with the Trading dependency closure')

  const { decideOrderGate } = await import(pathToFileURL(join(seed, 'node_modules/@dshtrading/base/lib/index.js')))
  for (const market of ['crypto', 'us', 'cn', 'hk']) {
    const presetYaml = await readFile(join(seed, `node_modules/@dshtrading/${market}/assets/preset/${market}-trader/agent.cordis.yml`), 'utf8')
    assert.match(presetYaml, /dryRun:\s*true/)
    assert.match(presetYaml, /liveTrading:\s*false/)
    assert.doesNotMatch(presetYaml, /(?:dryRun:\s*false|liveTrading:\s*true)/)
    assert.equal(decideOrderGate(`${market}_place_order`, { dryRun: false }).kind, 'ask')
    assert.equal(decideOrderGate(`${market}_cancel_order`, {}).kind, 'ask')
    assert.equal(decideOrderGate(`${market}_place_order`, { dryRun: true }), undefined)
  }

  await start()
  for (const path of ['/', '/dshtrading/api/markets', '/dshtrading/api/watchlists', '/dshtrading/api/events']) {
    assert.equal((await request(path)).status, 401, `anonymous ${path} must be denied`)
  }
  await login()
  const markets = await (await request('/dshtrading/api/markets', { authenticated: true })).json()
  assert.deepEqual(markets.markets.map((market) => market.id).sort(), ['cn', 'crypto', 'hk', 'us'])
  const page = await (await request('/', { authenticated: true, headers: { Accept: 'text/html' } })).text()
  assert(page.includes('@dshtrading/client-ui-trading'), 'Trading browser module must be in the actual boot manifest')
  const watchlists = { us: [{ symbol: 'AAPL', name: 'Apple' }] }
  const saved = await request('/dshtrading/api/watchlists', {
    authenticated: true,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: `https://${authority}` },
    body: JSON.stringify({ watchlists }),
  })
  assert.equal(saved.status, 200)
  assert.equal((await saved.json()).ok, true)
  assert((await readFile(join(workspace, '.dsh/watchlists.json'), 'utf8')).includes('AAPL'))
  await stop()
  await start()
  await login()
  const restored = await (await request('/dshtrading/api/watchlists', { authenticated: true })).json()
  assert.equal(restored.watchlists.us[0].symbol, 'AAPL', 'watchlist must survive restart')
  process.stdout.write('Trading smoke passed: four markets, login, anonymous API/SSE denial, UI boot, approval gate, persistent watchlists\n')
} catch (error) {
  // Startup logs can contain launch tokens. Never expose those in CI output.
  process.stderr.write(output.replace(/([?&]token=)[^\s"'<>]+/g, '$1[redacted]').slice(-16000))
  throw error
} finally {
  await stop()
  await rm(scratch, { recursive: true, force: true })
}
