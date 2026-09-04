import http from 'node:http'

function request({ host, port, path, headers, timeoutMs }) {
  return new Promise((resolve) => {
    const req = http.request({ host, port, path, method: 'GET', headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', () => resolve(undefined))
    req.end()
  })
}

/**
 * Verifies both public auth-gate endpoints without using a credential:
 * /auth/status must be served by the plugin and an API-style root request
 * must be denied.  This proves the intended fail-closed gate is mounted.
 */
export async function probeAuthGate({ host = '127.0.0.1', port, trustedHost, timeoutMs = 2_000 }) {
  const authStatus = await request({
    host,
    port,
    path: '/auth/status',
    timeoutMs,
    headers: { Host: trustedHost, Accept: 'application/json' },
  })
  if (authStatus?.statusCode !== 200) return false

  try {
    const payload = JSON.parse(authStatus.body)
    if (typeof payload.authenticated !== 'boolean') return false
  } catch {
    return false
  }

  const protectedRoot = await request({
    host,
    port,
    path: '/',
    timeoutMs,
    headers: { Host: trustedHost, Accept: 'application/json' },
  })
  return protectedRoot?.statusCode === 401
}
