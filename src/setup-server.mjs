import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'

const listenHost = process.env.SETUP_HOST ?? '0.0.0.0'
const listenPort = Number(process.env.SETUP_PORT ?? '8080')
const configPath = process.env.RUNTIME_CONFIG_PATH ?? '/data/dsh-server/runtime-config.json'
const setupCodePath = process.env.SETUP_CODE_PATH ?? '/data/dsh-server/setup-code'
const dshHome = process.env.DSH_HOME ?? '/data/dsh'
const authCli = process.env.AUTH_GATE_CLI ?? join(dshHome, 'profiles', 'web', 'node_modules', 'dsh-auth-gate', 'lib', 'cli.js')
const setupProtection = process.env.DSH_SETUP_PROTECTION ?? 'open'
const requireSetupCode = setupProtection === 'code'

if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('invalid SETUP_PORT')
if (!['open', 'code'].includes(setupProtection)) throw new Error('invalid DSH_SETUP_PROTECTION')

let completing = false

function html(res, statusCode, body) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'content-type': 'text/html; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function json(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}

function validateAuthority(value) {
  if (value === '' || value.includes(',') || /\s/.test(value) || value.includes('/') || value.includes('@')) return false
  try {
    const parsed = new URL(`http://${value}`)
    return parsed.host === value && parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
  } catch {
    return false
  }
}

function validUsername(value) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)
}

function page({ authority = '', error = '' } = {}) {
  const message = error === '' ? '' : `<p class="error">${escapeHtml(error)}</p>`
  const setupCodeInput = requireSetupCode
    ? '<label>一次性初始化码</label><input name="setupCode" type="password" required autocomplete="one-time-code">'
    : ''
  const protectionHint = requireSetupCode
    ? '输入容器日志中的一次性初始化码，创建管理员并确认公开访问域名。'
    : '创建管理员并确认公开访问域名。'
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>初始化 DSH Server Kit</title><style>
body{margin:0;background:#111827;color:#f9fafb;font:16px/1.5 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}.card{width:min(440px,calc(100% - 32px));padding:32px;border:1px solid #374151;border-radius:14px;background:#1f2937}h1{margin:0 0 8px;font-size:24px}p{color:#d1d5db}.hint{margin:6px 0 0;color:#9ca3af;font-size:13px}label{display:block;margin:16px 0 6px}input{box-sizing:border-box;width:100%;padding:10px;border:1px solid #4b5563;border-radius:8px;background:#111827;color:#fff}button{margin-top:24px;width:100%;padding:11px;border:0;border-radius:8px;background:#22c55e;color:#052e16;font-weight:700;cursor:pointer}.error{padding:10px;border-radius:8px;background:#7f1d1d;color:#fecaca}</style></head>
<body><main class="card"><h1>初始化 DSH Server Kit</h1><p>${protectionHint}</p>${message}
<form method="post" action="/setup"><label>公开域名</label><input name="trustedHost" required value="${escapeHtml(authority)}" autocomplete="url" spellcheck="false"><label>管理员用户名</label><input name="username" required minlength="1" maxlength="64" autocomplete="username" spellcheck="false" pattern="[A-Za-z0-9][A-Za-z0-9_.-]*" title="只能使用字母、数字、点、下划线和连字符"><p class="hint">以字母或数字开头；只能使用字母、数字、点、下划线和连字符，不支持邮箱。</p><label>管理员密码</label><input name="password" type="password" required minlength="12" autocomplete="new-password"><label>确认密码</label><input name="passwordConfirm" type="password" required minlength="12" autocomplete="new-password">${setupCodeInput}<button type="submit">完成初始化</button></form></main></body></html>`
}

async function ensureSetupCode() {
  try {
    const code = (await readFile(setupCodePath, 'utf8')).trim()
    if (!/^[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('setup code file is invalid')
    return { code, created: false }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    await mkdir(dirname(setupCodePath), { recursive: true, mode: 0o700 })
    const code = randomBytes(24).toString('base64url')
    await writeFile(setupCodePath, `${code}\n`, { mode: 0o600, flag: 'wx' })
    return { code, created: true }
  }
}

function isValidCode(candidate, expected) {
  const actual = Buffer.from(candidate)
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

function readForm(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 16 * 1024) {
        req.destroy()
        reject(new Error('form too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))))
    req.on('error', reject)
  })
}

function createAuthUser(username, password) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [authCli, 'user', 'add', username, '--password-stdin'], {
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('auth user creation failed')))
    child.stdin.end(`${password}\n`)
  })
}

async function writeRuntimeConfig(trustedHost) {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const temporary = `${configPath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, trustedHost, configuredAt: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' })
  await rename(temporary, configPath)
}

let setupCode = ''
if (requireSetupCode) {
  const result = await ensureSetupCode()
  setupCode = result.code
  process.stdout.write(`${JSON.stringify(result.created
    ? { event: 'initial_setup_required', setupCode }
    : { event: 'initial_setup_required', setupCodeAvailable: true })}\n`)
} else {
  await unlink(setupCodePath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error
  })
  process.stdout.write(`${JSON.stringify({ event: 'initial_setup_required', protection: 'open' })}\n`)
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://setup.internal').pathname
  if (req.method === 'GET' && path === '/healthz') return json(res, 200, { status: 'setup_required' })
  if (req.method === 'GET' && path === '/readyz') return json(res, 503, { status: 'setup_required' })
  if (req.method === 'GET' && (path === '/' || path === '/setup')) return html(res, 200, page({ authority: req.headers.host ?? '' }))

  if (req.method === 'POST' && path === '/setup') {
    if (completing) return html(res, 409, page({ authority: req.headers.host ?? '', error: '初始化正在进行，请稍后刷新。' }))
    completing = true
    try {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) throw new Error('请求格式不正确。')
      const form = await readForm(req)
      const trustedHost = form.trustedHost ?? ''
      const username = form.username ?? ''
      const password = form.password ?? ''
      if (requireSetupCode && !isValidCode(form.setupCode ?? '', setupCode)) throw new Error('一次性初始化码无效。')
      if (!validateAuthority(trustedHost)) throw new Error('公开域名格式无效。')
      if (!validUsername(username)) throw new Error('管理员用户名格式无效。')
      if (password.length < 12 || password !== form.passwordConfirm) throw new Error('密码至少需要 12 位，且两次输入必须一致。')

      await createAuthUser(username, password)
      await writeRuntimeConfig(trustedHost)
      if (requireSetupCode) await unlink(setupCodePath)
      html(res, 202, '<!doctype html><meta charset="utf-8"><title>初始化完成</title><p>初始化完成，DSH 正在启动。请在几秒后刷新当前页面。</p>')
      process.stdout.write(`${JSON.stringify({ event: 'initial_setup_completed' })}\n`)
    } catch (error) {
      completing = false
      html(res, 400, page({ authority: req.headers.host ?? '', error: error instanceof Error ? error.message : '初始化失败。' }))
    }
    return
  }

  json(res, 404, { status: 'not_found' })
})

server.listen(listenPort, listenHost, () => {
  process.stdout.write(`${JSON.stringify({ event: 'setup_server_listening', port: listenPort })}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
